//! The dictionaries the reader has imported, and looking a word up in them.
//!
//! The list itself is backend-owned config in the `settings` KV table — one
//! JSON document, the shape `sync.webdav` also uses, because a dictionary is
//! added and removed as a whole and nothing queries into the list. Each bundle
//! then lives under `<data dir>/dictionaries/<id>/` with fixed file names, so
//! the on-disk layout needs no bookkeeping beyond the id.
//!
//! Why this exists at all: it is the offline layer below the platform
//! dictionary. macOS answers out of the system's own dictionary, but Windows and
//! Linux ship no equivalent, and a reader who wants a Chinese-English dictionary
//! on those platforms should not need an API key for it. Importing the bundle
//! the reader already has is cheaper for everyone than shipping a dataset.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::mdict;
use crate::library::stardict::{self, Index};

/// The settings row holding the whole list.
const KEY: &str = "lookup.dictionaries";

/// Fixed names inside a bundle; the reader never has to remember the originals.
/// A StarDict dictionary is three files, an MDict one is a single `.mdx` — the
/// header inside it carries what a StarDict `.ifo` would.
const IFO: &str = "meta.ifo";
const INDEX: &str = "index.idx";
const BODY: &str = "body.dict";
const MDX: &str = "body.mdx";

/// The formats a bundle can hold.
const STARDICT: &str = "stardict";
const MDICT: &str = "mdict";

/// One imported dictionary, as the settings document and the UI hold it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictionary {
    pub id: String,
    pub name: String,
    /// Which reader to open the bundle with. Defaulted rather than required so
    /// a list written before the second format still loads.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// As the bundle declares it; kept for display, not trusted for sizing.
    pub wordcount: u64,
    pub added_at: i64,
}

fn default_kind() -> String {
    STARDICT.to_string()
}

/// One lookup that landed.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub text: String,
    /// The dictionary's own name, so the popup can say where the answer is from.
    pub source: String,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}

/// What a lookup needs from disk, per dictionary.
///
/// Parsed once: for StarDict the index offsets, for MDict the header and both
/// block indexes. Rebuilding either is a scan of a multi-megabyte file, and
/// neither can change while the bundle exists.
#[derive(Clone)]
enum Cached {
    StarDict(Arc<Vec<u32>>),
    Mdict(Arc<mdict::Index>),
}

static CACHE: LazyLock<Mutex<HashMap<String, Cached>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Every imported dictionary, in the order the reader added them.
pub fn list(library: &Library) -> AppResult<Vec<Dictionary>> {
    library.with(|conn| {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |row| row.get(0))
            .optional()?;
        match stored {
            Some(json) => serde_json::from_str(&json)
                .map_err(|err| AppError::Message(format!("本地词典列表已损坏，请重新导入：{err}"))),
            None => Ok(Vec::new()),
        }
    })
}

fn store(library: &Library, dictionaries: &[Dictionary]) -> AppResult<()> {
    let json = serde_json::to_string(dictionaries)?;
    library.with(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                               updated_at = excluded.updated_at",
            rusqlite::params![KEY, json, crate::library::now_seconds()],
        )?;
        Ok(())
    })
}

/// Copies a dictionary in and records it, dispatching on the picked file.
///
/// The reader picks one file — a StarDict `.ifo` or an MDict `.mdx` — and the
/// rest of the bundle is found relative to it.
pub fn import(library: &Library, root: &Path, path: &Path) -> AppResult<Dictionary> {
    if crate::library::has_extension(path, &["ifo"]) {
        import_stardict(library, root, path)
    } else if crate::library::has_extension(path, &["mdx"]) {
        import_mdict(library, root, path)
    } else {
        Err(invalid("请选择 StarDict 词典的 .ifo 文件，或 MDict 词典的 .mdx 文件"))
    }
}

/// The tail both formats share: refuse a duplicate name, write the bundle, then
/// record it — rolling the directory back if either step fails.
fn finish(
    library: &Library,
    root: &Path,
    name: String,
    kind: &str,
    wordcount: u64,
    write: impl FnOnce(&Path) -> AppResult<()>,
) -> AppResult<Dictionary> {
    let mut dictionaries = list(library)?;
    if dictionaries.iter().any(|entry| entry.name == name) {
        return Err(invalid(format!("《{name}》已经导入过了")));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let bundle = root.join(&id);
    std::fs::create_dir_all(&bundle)?;
    if let Err(err) = write(&bundle) {
        // Half a bundle is worse than none: it would list as an available
        // dictionary whose files only partly parse.
        let _ = std::fs::remove_dir_all(&bundle);
        return Err(err);
    }

    let dictionary = Dictionary {
        id,
        name,
        kind: kind.to_string(),
        wordcount,
        added_at: crate::library::now_seconds(),
    };
    dictionaries.push(dictionary.clone());
    if let Err(err) = store(library, &dictionaries) {
        let _ = std::fs::remove_dir_all(&bundle);
        return Err(err);
    }
    Ok(dictionary)
}

/// Copies a StarDict bundle in.
///
/// The reader picks the `.ifo`; the sibling `.idx` and `.dict` (or `.dict.dz`)
/// come from the same directory. The body is written out **uncompressed**: a
/// `.dict.dz` has no random access, and inflating the whole dictionary on every
/// word would cost more than the disk costs once.
fn import_stardict(library: &Library, root: &Path, ifo: &Path) -> AppResult<Dictionary> {
    let stem = ifo.file_stem().ok_or_else(|| invalid("无法从文件名推断词典"))?;
    let base = ifo.with_file_name(stem);

    let mut metadata = stardict::parse_ifo(&String::from_utf8_lossy(&std::fs::read(ifo)?))?;

    let index_path = base.with_extension("idx");
    if !index_path.exists() {
        return Err(invalid(format!(
            "找不到索引文件 {}，请把 .ifo、.idx、.dict 放在同一个目录",
            index_path.display()
        )));
    }
    let plain = base.with_extension("dict");
    let packed = base.with_extension("dict.dz");
    let (body_path, compressed) = if plain.exists() {
        (plain, false)
    } else if packed.exists() {
        (packed, true)
    } else {
        return Err(invalid("找不到正文文件（.dict 或 .dict.dz）"));
    };

    // Parse the index now, so a truncated bundle fails here — where the reader
    // is looking — instead of silently never answering a lookup.
    let offsets = stardict::entry_offsets(&std::fs::read(&index_path)?)?;
    if offsets.is_empty() {
        return Err(invalid("这本词典的索引是空的"));
    }
    // The `.ifo` name wins when it is blank, but a name is required by
    // `parse_ifo`; have the count reflect the index when the header lies.
    if metadata.wordcount == 0 {
        metadata.wordcount = offsets.len() as u64;
    }

    let name = metadata.bookname;
    let wordcount = metadata.wordcount;
    finish(library, root, name, STARDICT, wordcount, |bundle| {
        write_bundle(ifo, &index_path, &body_path, compressed, bundle)
    })
}

/// Copies an MDict dictionary in.
///
/// Nothing is decompressed on the way in: an `.mdx` keeps its blocks compressed
/// and a lookup inflates only the key block and the record block it needs. The
/// index is walked here anyway, so a file this build cannot read is refused at
/// import — where the reader is looking — instead of quietly never answering.
///
/// ponytail: the sibling `.mdd` resource bundle is not copied. The popup shows
/// text, so a dictionary's pictures and audio would be dead weight; an entry
/// that references one renders without it.
fn import_mdict(library: &Library, root: &Path, mdx: &Path) -> AppResult<Dictionary> {
    let index = mdict::open_index(mdx)?;
    let name = if index.metadata.title.is_empty() {
        mdx.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        index.metadata.title.clone()
    };
    if name.is_empty() {
        return Err(invalid("这本 MDict 词典没有名字"));
    }
    let wordcount = index.wordcount;
    finish(library, root, name, MDICT, wordcount, |bundle| {
        std::fs::copy(mdx, bundle.join(MDX))?;
        Ok(())
    })
}

fn write_bundle(
    ifo: &Path,
    index: &Path,
    body: &Path,
    compressed: bool,
    bundle: &Path,
) -> AppResult<()> {
    std::fs::copy(ifo, bundle.join(IFO))?;
    std::fs::copy(index, bundle.join(INDEX))?;
    let mut input = std::io::BufReader::new(std::fs::File::open(body)?);
    let mut output = std::io::BufWriter::new(std::fs::File::create(bundle.join(BODY))?);
    if compressed {
        // `MultiGzDecoder`, not `GzDecoder`: a `.dz` is frequently several gzip
        // members concatenated, and the plain decoder stops after the first —
        // which would silently truncate the dictionary.
        let mut decoder = flate2::read::MultiGzDecoder::new(input);
        std::io::copy(&mut decoder, &mut output)?;
    } else {
        std::io::copy(&mut input, &mut output)?;
    }
    output.flush()?;
    Ok(())
}

/// Forgets a dictionary and deletes its files.
///
/// The list is authoritative and goes first: once the entry is out of it the
/// dictionary is gone even if unlinking fails, because an orphan directory is
/// invisible while an orphan entry resurrects on next boot.
pub fn remove(library: &Library, root: &Path, id: &str) -> AppResult<()> {
    let mut dictionaries = list(library)?;
    let before = dictionaries.len();
    dictionaries.retain(|entry| entry.id != id);
    if dictionaries.len() == before {
        return Err(AppError::NotFound(id.to_string()));
    }
    store(library, &dictionaries)?;
    cache().remove(id);

    let bundle = root.join(id);
    if let Err(err) = std::fs::remove_dir_all(&bundle) {
        tracing::warn!(path = %bundle.display(), error = %err, "删除词典文件失败");
    }
    Ok(())
}

/// Looks `term` up in every imported dictionary, first hit wins.
pub fn lookup(library: &Library, root: &Path, term: &str) -> AppResult<Option<Hit>> {
    let term = term.trim();
    if term.is_empty() {
        return Ok(None);
    }
    for dictionary in list(library)? {
        match query(root, &dictionary, term) {
            Ok(Some(text)) => return Ok(Some(Hit { text, source: dictionary.name })),
            Ok(None) => {}
            // One broken bundle must not take the others down with it; the
            // reader can delete it from settings once the log says so.
            Err(err) => {
                tracing::warn!(dictionary = %dictionary.name, error = %err, "本地词典查询失败");
            }
        }
    }
    Ok(None)
}

/// The entry for `term` in one dictionary, decoded, with the reader its format
/// calls for.
fn query(root: &Path, dictionary: &Dictionary, term: &str) -> AppResult<Option<String>> {
    let bundle = root.join(&dictionary.id);
    match cached(root, dictionary)? {
        Cached::StarDict(offsets) => {
            let metadata =
                stardict::parse_ifo(&String::from_utf8_lossy(&std::fs::read(bundle.join(IFO))?))?;
            let mut index = Index::open(&bundle.join(INDEX), offsets)?;

            // Exact first, then the lowercased form: plenty of dictionaries
            // index only lowercase headwords while the selection keeps its
            // capital.
            let entry = match index.find(term)? {
                Some(found) => Some(found),
                None => {
                    let lowered = term.to_lowercase();
                    if lowered == term { None } else { index.find(&lowered)? }
                }
            };
            let Some(entry) = entry else { return Ok(None) };
            let body = stardict::read_body(&bundle.join(BODY), &entry)?;
            Ok(stardict::decode(&body, metadata.sametypesequence.as_deref()))
        }
        Cached::Mdict(index) => mdict::Reader::open(&bundle.join(MDX), index)?.lookup(term),
    }
}

/// What one dictionary needs from disk, parsed on first use.
fn cached(root: &Path, dictionary: &Dictionary) -> AppResult<Cached> {
    let mut cache = cache();
    if let Some(found) = cache.get(&dictionary.id) {
        return Ok(found.clone());
    }
    let bundle = root.join(&dictionary.id);
    let computed = if dictionary.kind == MDICT {
        Cached::Mdict(Arc::new(mdict::open_index(&bundle.join(MDX))?))
    } else {
        // The index stays on disk; only the offset list is held.
        Cached::StarDict(Arc::new(stardict::entry_offsets(&std::fs::read(bundle.join(INDEX))?)?))
    };
    cache.insert(dictionary.id.clone(), computed.clone());
    Ok(computed)
}

/// The parsed-index cache. A poisoned lock still holds a usable map, so it is
/// taken rather than unwrapped — a panic in one lookup must not poison every
/// later one.
fn cache() -> std::sync::MutexGuard<'static, HashMap<String, Cached>> {
    CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Writes a bundle straight from the format description — deliberately not
    /// reusing `stardict`'s test helper, so the reader is checked against an
    /// independent writer.
    fn bundle(dir: &Path, name: &str, entries: &[(&str, &str)]) -> PathBuf {
        std::fs::create_dir_all(dir).expect("dir");
        let mut body = Vec::new();
        let mut index = Vec::new();
        for (word, meaning) in entries {
            index.extend_from_slice(word.as_bytes());
            index.push(0);
            index.extend_from_slice(&(body.len() as u32).to_be_bytes());
            index.extend_from_slice(&(meaning.len() as u32).to_be_bytes());
            body.extend_from_slice(meaning.as_bytes());
        }
        let ifo = dir.join(format!("{name}.ifo"));
        std::fs::write(
            &ifo,
            format!(
                "StarDict's dict ifo file\nversion=2.4.2\nbookname={name}\nwordcount={}\n\
                 idxfilesize={}\nsametypesequence=m\n",
                entries.len(),
                index.len()
            ),
        )
        .expect("ifo");
        std::fs::write(dir.join(format!("{name}.idx")), &index).expect("idx");
        std::fs::write(dir.join(format!("{name}.dict")), &body).expect("dict");
        ifo
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("colorreader-dictionaries-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn an_imported_dictionary_answers_a_lookup_and_says_where_from() {
        let dir = scratch("roundtrip");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("dictionaries");
        let source =
            bundle(&dir.join("source"), "迷你词典", &[("hello", "你好"), ("world", "世界")]);

        let imported = import(&library, &root, &source).expect("import");
        assert_eq!(imported.name, "迷你词典");
        assert_eq!(imported.kind, "stardict");
        assert_eq!(imported.wordcount, 2);
        assert_eq!(list(&library).expect("list").len(), 1);

        let hit = lookup(&library, &root, "hello").expect("lookup").expect("命中");
        assert_eq!(hit.text, "你好");
        assert_eq!(hit.source, "迷你词典");
        assert_eq!(
            lookup(&library, &root, "  world  ").expect("lookup").expect("裁剪空白").text,
            "世界"
        );
        assert!(lookup(&library, &root, "missing").expect("lookup").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn both_formats_answer_through_the_same_entry_point() {
        let dir = scratch("formats");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("dictionaries");

        // A StarDict bundle this test writes itself, plus the MDict fixture a
        // third-party writer produced: one command, two readers.
        import(&library, &root, &bundle(&dir.join("one"), "星典", &[("apple", "苹果（星典）")]))
            .expect("stardict import");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.mdx");
        let mdict = import(&library, &root, &fixture).expect("mdict import");

        assert_eq!(mdict.kind, "mdict");
        assert_eq!(mdict.name, "迷你词典");
        assert_eq!(mdict.wordcount, 44);
        assert_eq!(list(&library).expect("list").len(), 2);

        // Both carry `apple`; the one imported first wins, which is the order
        // the settings list promises.
        let hit = lookup(&library, &root, "apple").expect("lookup").expect("命中");
        assert_eq!(hit.source, "星典");
        assert_eq!(hit.text, "苹果（星典）");

        // And each reader still answers for the words only it has.
        let hit = lookup(&library, &root, "hello").expect("lookup").expect("MDict 命中");
        assert_eq!(hit.text, "你好");
        assert_eq!(hit.source, "迷你词典");
        assert_eq!(lookup(&library, &root, "markup").expect("lookup").expect("命中").text, "粗体");
        assert!(lookup(&library, &root, "zzzzqqqq").expect("lookup").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn importing_the_same_mdict_twice_is_refused() {
        let dir = scratch("mdict-duplicate");
        let library = Library::open(&dir).expect("library");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.mdx");
        import(&library, &dir.join("dictionaries"), &fixture).expect("first import");
        assert!(matches!(
            import(&library, &dir.join("dictionaries"), &fixture),
            Err(AppError::InvalidArgument(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn importing_the_same_name_twice_is_refused() {
        let dir = scratch("duplicate");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("dictionaries");
        let source = bundle(&dir.join("source"), "词典", &[("a", "1")]);
        import(&library, &root, &source).expect("first import");
        assert!(matches!(import(&library, &root, &source), Err(AppError::InvalidArgument(_))));
        assert_eq!(list(&library).expect("list").len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bundle_missing_its_index_is_refused_without_leaving_a_directory() {
        let dir = scratch("partial");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("dictionaries");
        let source = bundle(&dir.join("source"), "残缺", &[("a", "1")]);
        std::fs::remove_file(dir.join("source").join("残缺.idx")).expect("remove idx");

        assert!(matches!(import(&library, &root, &source), Err(AppError::InvalidArgument(_))));
        assert!(list(&library).expect("list").is_empty());
        let leftovers = std::fs::read_dir(&root).map(|entries| entries.count()).unwrap_or(0);
        assert_eq!(leftovers, 0, "失败的导入不能留下半份词典");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_dictionary_deletes_its_files_and_stops_answering() {
        let dir = scratch("remove");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("dictionaries");
        let source = bundle(&dir.join("source"), "临时", &[("a", "1")]);
        let imported = import(&library, &root, &source).expect("import");

        remove(&library, &root, &imported.id).expect("remove");
        assert!(list(&library).expect("list").is_empty());
        assert!(!root.join(&imported.id).exists(), "文件也要删掉");
        assert!(lookup(&library, &root, "a").expect("lookup").is_none());
        assert!(matches!(remove(&library, &root, "nope"), Err(AppError::NotFound(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_deleted_bundle_does_not_break_the_other_dictionaries() {
        let dir = scratch("resilient");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("dictionaries");
        let broken = import(&library, &root, &bundle(&dir.join("one"), "坏的", &[("a", "1")]))
            .expect("import");
        import(&library, &root, &bundle(&dir.join("two"), "好的", &[("a", "answer")]))
            .expect("import");

        // The reader wiped one bundle outside the app; the other must still work.
        std::fs::remove_dir_all(root.join(&broken.id)).expect("remove files");
        let hit = lookup(&library, &root, "a").expect("lookup").expect("另一本仍然可用");
        assert_eq!(hit.source, "好的");
        assert_eq!(hit.text, "answer");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dict_archive_is_unpacked_on_the_way_in() {
        let dir = scratch("gzip");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("dictionaries");
        let source_dir = dir.join("source");
        let ifo = bundle(&source_dir, "压缩的", &[("hello", "你好")]);

        // Pack the body the way a real .dz release ships it, then drop the plain
        // one so the importer has to take the compressed path.
        let plain = source_dir.join("压缩的.dict");
        let packed = source_dir.join("压缩的.dict.dz");
        let raw = std::fs::read(&plain).expect("read body");
        let mut encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&packed).expect("create dz"),
            flate2::Compression::default(),
        );
        encoder.write_all(&raw).expect("compress");
        encoder.finish().expect("finish");
        std::fs::remove_file(&plain).expect("remove plain");

        import(&library, &root, &ifo).expect("import");
        assert_eq!(lookup(&library, &root, "hello").expect("lookup").expect("命中").text, "你好");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unrelated_file_is_refused_by_extension() {
        let dir = scratch("extension");
        let library = Library::open(&dir).expect("library");
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, "hello").expect("write");
        assert!(matches!(
            import(&library, &dir.join("dictionaries"), &txt),
            Err(AppError::InvalidArgument(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
