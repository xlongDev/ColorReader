//! The import pipeline: hash, dedupe, copy, extract cover, record.
//!
//! One failure never aborts the batch. Each file reports its own outcome so the
//! UI can say "3 imported, 1 duplicate, 1 failed" instead of losing the run.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::pack;
use super::repository::{self, NewBook};
use crate::db::{Layout, Library};
use crate::document::{self, detect_format};
use crate::error::{AppError, AppResult};

/// What happened to one file in the batch.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportOutcome {
    Imported {
        path: String,
        id: String,
        title: String,
    },
    /// The same bytes are already on the shelf.
    Duplicate {
        path: String,
        id: String,
        title: String,
    },
    Failed {
        path: String,
        message: String,
    },
}

impl ImportOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, ImportOutcome::Imported { .. } | ImportOutcome::Duplicate { .. })
    }
}

/// Imports every path, reporting progress after each file.
///
/// `password` is only consulted by `.ctzx` packs; every other format ignores
/// it, so a mixed batch works with one prompt.
pub fn import_files(
    library: &Library,
    layout: &Layout,
    paths: &[PathBuf],
    password: Option<&str>,
    on_progress: &mut dyn FnMut(usize, usize, &str),
) -> Vec<ImportOutcome> {
    let total = paths.len();
    let mut outcomes = Vec::with_capacity(total);

    for (index, path) in paths.iter().enumerate() {
        let outcome = match import_one(library, layout, path, password) {
            Ok(result) => result,
            Err(err) => {
                tracing::warn!(file = %path.display(), error = %err, "导入失败");
                ImportOutcome::Failed {
                    path: path.to_string_lossy().to_string(),
                    message: err.to_string(),
                }
            }
        };
        on_progress(index + 1, total, &path.to_string_lossy());
        outcomes.push(outcome);
    }

    outcomes
}

/// Successful result of importing a single file.
enum Imported {
    Created(String, String),
    AlreadyPresent(String, String),
}

impl Imported {
    fn id(&self) -> &str {
        match self {
            Imported::Created(id, _) | Imported::AlreadyPresent(id, _) => id,
        }
    }
}

fn import_one(
    library: &Library,
    layout: &Layout,
    path: &Path,
    password: Option<&str>,
) -> AppResult<ImportOutcome> {
    let path_text = path.to_string_lossy().to_string();
    let outcome = if pack::is_pack(path) {
        import_pack(library, layout, path, password)?
    } else {
        import_book(library, layout, path)?
    };
    Ok(match outcome {
        Imported::Created(id, title) => ImportOutcome::Imported { path: path_text, id, title },
        Imported::AlreadyPresent(id, title) => {
            ImportOutcome::Duplicate { path: path_text, id, title }
        }
    })
}

/// Unpacks a book pack, then runs the ordinary pipeline on what was inside.
///
/// The source is staged inside the library's own book directory rather than in
/// a system temp folder: the pipeline hashes, parses and copies from a path, so
/// a staging file keeps all three untouched and stays on the same filesystem.
fn import_pack(
    library: &Library,
    layout: &Layout,
    path: &Path,
    password: Option<&str>,
) -> AppResult<Imported> {
    let unpacked = pack::unpack(path, password)?;
    let staged =
        layout.books_dir.join(format!("unpack-{}.{}", uuid::Uuid::new_v4(), unpacked.source_ext));
    std::fs::write(&staged, &unpacked.source)?;

    let outcome = import_book(library, layout, &staged);
    // The pipeline has copied what it needs; the staging copy is always ours
    // to remove, on the happy path and on every failure.
    if let Err(err) = std::fs::remove_file(&staged) {
        tracing::warn!(path = %staged.display(), error = %err, "清理解包临时文件失败");
    }

    let imported = outcome?;
    if let Some(reading) = &unpacked.reading {
        library.with(|conn| pack::apply_reading(conn, imported.id(), reading))?;
    }
    Ok(imported)
}

fn import_book(library: &Library, layout: &Layout, path: &Path) -> AppResult<Imported> {
    let format = detect_format(path)?;
    let hash = sha256_file(path)?;

    // Cheap pre-check so the common case (re-importing the same file) never
    // touches the disk. The chapters are still re-extracted: they are derived
    // data, and a parser fix (e.g. keeping images) must reach old books when
    // the user re-imports the same file.
    if let Some((id, title)) = library.with(|conn| repository::find_by_hash(conn, &hash))? {
        match document::read_chapters(path, format) {
            Ok(raw) => library.with_tx(|tx| super::chapters::replace(tx, &id, &raw))?,
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "重复导入时刷新章节失败");
            }
        }
        return Ok(Imported::AlreadyPresent(id, title));
    }

    let metadata = document::read_metadata(path, format)?;
    let file_size = i64::try_from(fs::metadata(path)?.len()).unwrap_or(i64::MAX);
    let id = uuid::Uuid::new_v4().to_string();

    // Chapter extraction is best-effort: a book can sit on the shelf even if
    // the spine is empty, and the reader will re-attempt lazily.
    let chapters = document::read_chapters(path, format).unwrap_or_else(|err| {
        tracing::warn!(path = %path.display(), error = %err, "章节提取失败，将以空章节入库");
        Vec::new()
    });

    // Files are copied into the library directory so deleting or moving the
    // original never breaks the shelf.
    let stored = layout.books_dir.join(format!("{id}.{}", format.extension()));
    fs::copy(path, &stored)?;

    let cover_path = match &metadata.cover {
        Some(cover) => {
            let target = layout
                .covers_dir
                .join(format!("{id}.{}", document::safe_image_extension(&cover.extension)));
            fs::write(&target, &cover.bytes)?;
            Some(target)
        }
        None => None,
    };

    let stored_text = stored.to_string_lossy().to_string();
    let cover_text = cover_path.as_ref().map(|path| path.to_string_lossy().to_string());

    let inserted = library.with_tx(|tx| {
        repository::insert(
            tx,
            &NewBook {
                id: &id,
                title: &metadata.title,
                subtitle: metadata.subtitle.as_deref(),
                description: metadata.description.as_deref(),
                language: metadata.language.as_deref(),
                publisher: metadata.publisher.as_deref(),
                identifier: metadata.identifier.as_deref(),
                format,
                content_hash: &hash,
                file_path: &stored_text,
                file_size,
                cover_path: cover_text.as_deref(),
                authors: &metadata.authors,
            },
        )?;
        super::chapters::insert(tx, &id, &chapters)
    });

    match inserted {
        Ok(()) => Ok(Imported::Created(id, metadata.title)),
        Err(err) => {
            cleanup(&stored, cover_path.as_deref());
            // A concurrent import may have won the race; the UNIQUE constraint
            // on content_hash decides either way.
            if is_unique_violation(&err)
                && let Some((existing, title)) =
                    library.with(|conn| repository::find_by_hash(conn, &hash))?
            {
                return Ok(Imported::AlreadyPresent(existing, title));
            }
            Err(err)
        }
    }
}

fn cleanup(book: &Path, cover: Option<&Path>) {
    if let Err(err) = fs::remove_file(book) {
        tracing::warn!(path = %book.display(), error = %err, "清理已复制的书籍文件失败");
    }
    if let Some(cover) = cover
        && let Err(err) = fs::remove_file(cover)
    {
        tracing::warn!(path = %cover.display(), error = %err, "清理已提取的封面失败");
    }
}

fn is_unique_violation(error: &AppError) -> bool {
    matches!(error, AppError::Database(rusqlite::Error::SqliteFailure(_, Some(message)))
        if message.contains("UNIQUE"))
}

/// Streams the file through SHA-256; books are far too large to hash in memory.
fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(super::to_hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;
    use crate::library::repository::{BookQuery, LibraryFilter, LibrarySort};

    struct Harness {
        dir: PathBuf,
        layout: Layout,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&dir).expect("open library");
            Self { dir, layout, library }
        }

        fn import(&self, paths: &[PathBuf]) -> Vec<ImportOutcome> {
            import_files(&self.library, &self.layout, paths, None, &mut |_, _, _| {})
        }

        fn shelve(&self) -> Vec<repository::BookSummary> {
            self.library.with(|conn| repository::list(conn, &BookQuery::default())).expect("list")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn opf() -> String {
        fixture::full_opf("三体", "刘慈欣")
    }

    fn epub(dir: &Path, name: &str, title: &str) -> PathBuf {
        fixture::write_epub(
            dir,
            name,
            &fixture::full_opf(title, "刘慈欣"),
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        )
    }

    #[test]
    fn an_epub_lands_on_the_shelf_with_metadata_and_cover() {
        let harness = Harness::new("import-epub");
        let source = epub(&harness.dir, "source.epub", "三体");

        let outcomes = harness.import(&[source]);
        let imported = match &outcomes[0] {
            ImportOutcome::Imported { id, title, .. } => (id.clone(), title.clone()),
            other => panic!("期望导入成功，实际 {other:?}"),
        };
        assert_eq!(imported.1, "三体");

        let books = harness.shelve();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].title, "三体");
        assert_eq!(books[0].authors, ["刘慈欣"]);
        assert_eq!(books[0].format, crate::document::BookFormat::Epub);
        assert_eq!(
            books[0].cover_url.as_deref(),
            Some(crate::library::cover_url(&imported.0).as_str())
        );

        // The cover bytes must be on disk, not just referenced.
        let (_, cover) = crate::library::book_files(&harness.library, &imported.0).expect("files");
        let cover = cover.expect("封面文件必须存在");
        assert_eq!(std::fs::read(cover).expect("read"), fixture::png_bytes());
    }

    #[test]
    fn the_original_file_is_copied_into_the_library_directory() {
        let harness = Harness::new("import-copy");
        let source = epub(&harness.dir, "source.epub", "三体");
        harness.import(std::slice::from_ref(&source));

        let books = harness.shelve();
        let (stored, _) =
            crate::library::book_files(&harness.library, &books[0].id).expect("files");
        let stored = stored.expect("书籍文件必须存在");
        assert!(stored.starts_with(&harness.layout.books_dir));
        assert_ne!(stored, source, "必须复制而不是原地引用");
    }

    #[test]
    fn importing_the_same_bytes_twice_is_reported_as_a_duplicate() {
        let harness = Harness::new("import-dupe");
        let first = epub(&harness.dir, "a.epub", "三体");
        let second = epub(&harness.dir, "b.epub", "三体");

        harness.import(&[first]);
        let outcomes = harness.import(&[second]);

        assert!(matches!(&outcomes[0], ImportOutcome::Duplicate { .. }), "{:?}", outcomes[0]);
        assert_eq!(harness.shelve().len(), 1, "重复导入不得产生第二行记录");
    }

    #[test]
    fn a_different_file_with_the_same_title_is_a_separate_book() {
        let harness = Harness::new("import-same-title");
        let a = epub(&harness.dir, "a.epub", "三体");
        // Same title, different bytes: the hash distinguishes them.
        let b = {
            let mut opf = opf();
            opf.push_str("<!-- different -->");
            fixture::write_epub(&harness.dir, "b.epub", &opf, &[])
        };

        let outcomes = harness.import(&[a, b]);
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes.iter().all(ImportOutcome::is_success), "{outcomes:?}");
        assert_eq!(harness.shelve().len(), 2);
    }

    #[test]
    fn a_comic_archive_lands_with_one_chapter_per_page() {
        let harness = Harness::new("import-cbz");
        let bytes = fixture::png_bytes();
        let source = fixture::write_zip(
            &harness.dir,
            "book.cbz",
            &[("002.png", &bytes), ("001.png", &bytes), ("003.png", &bytes)],
        );

        let outcomes = harness.import(&[source]);
        assert!(matches!(&outcomes[0], ImportOutcome::Imported { .. }), "{:?}", outcomes[0]);

        let books = harness.shelve();
        assert_eq!(books[0].format, crate::document::BookFormat::Cbz);
        // No metadata block in a CBZ, so the file name is the title.
        assert_eq!(books[0].title, "book");
        let chapters = harness
            .library
            .with(|conn| crate::library::chapters::list(conn, &books[0].id))
            .expect("chapters");
        assert_eq!(chapters.len(), 3, "{chapters:?}");
        assert_eq!(chapters[0].title, "第 1 页");
    }

    #[test]
    fn unsupported_formats_fail_without_stopping_the_batch() {
        let harness = Harness::new("import-bad");
        let good = epub(&harness.dir, "good.epub", "三体");
        let bad = harness.dir.join("bad.doc");
        std::fs::write(&bad, b"not a book").expect("write");

        let outcomes = harness.import(&[bad, good]);
        assert!(matches!(&outcomes[0], ImportOutcome::Failed { .. }), "{:?}", outcomes[0]);
        assert!(matches!(&outcomes[1], ImportOutcome::Imported { .. }), "{:?}", outcomes[1]);
        assert_eq!(harness.shelve().len(), 1);
    }

    #[test]
    fn a_locked_pack_fails_the_file_without_stopping_the_batch() {
        let harness = Harness::new("import-locked-pack");
        let source = epub(&harness.dir, "source.epub", "三体");
        harness.import(&[source]);
        let id = harness.shelve()[0].id.clone();

        let locked = harness.dir.join("locked.ctzx");
        pack::export(&harness.library, &id, &locked, Some("pw")).expect("export");

        let outcomes = harness.import(&[locked]);
        let ImportOutcome::Failed { message, .. } = &outcomes[0] else {
            panic!("缺少密码必须报失败，实际 {:?}", outcomes[0]);
        };
        assert!(message.contains("密码"), "{message}");
    }

    #[test]
    fn a_missing_file_is_reported_not_thrown() {
        let harness = Harness::new("import-missing");
        let outcomes = harness.import(&[harness.dir.join("nope.epub")]);
        assert!(matches!(&outcomes[0], ImportOutcome::Failed { .. }));
        assert!(harness.shelve().is_empty());
    }

    #[test]
    fn progress_is_reported_once_per_file() {
        let harness = Harness::new("import-progress");
        let a = epub(&harness.dir, "a.epub", "A");
        let b = epub(&harness.dir, "b.epub", "B");

        let mut seen: Vec<(usize, usize)> = Vec::new();
        import_files(&harness.library, &harness.layout, &[a, b], None, &mut |done, total, _| {
            seen.push((done, total));
        });
        assert_eq!(seen, [(1, 2), (2, 2)]);
    }

    #[test]
    fn plain_text_books_import_using_their_file_name() {
        let harness = Harness::new("import-txt");
        let path = harness.dir.join("三体.txt");
        std::fs::write(&path, "正文内容").expect("write");

        harness.import(&[path]);
        let books = harness.shelve();
        assert_eq!(books[0].title, "三体");
        assert!(books[0].authors.is_empty());
        assert!(books[0].cover_url.is_none());
    }

    #[test]
    fn favorites_and_recent_filters_apply_after_import() {
        let harness = Harness::new("import-filter");
        let a = epub(&harness.dir, "a.epub", "A");
        harness.import(&[a]);

        let books = harness.shelve();
        let id = &books[0].id;
        harness.library.with(|conn| repository::set_favorite(conn, id, true)).expect("favorite");

        let favorites = harness
            .library
            .with(|conn| {
                repository::list(
                    conn,
                    &BookQuery { filter: LibraryFilter::Favorites, ..Default::default() },
                )
            })
            .expect("list");
        assert_eq!(favorites.len(), 1);

        let recent = harness
            .library
            .with(|conn| {
                repository::list(
                    conn,
                    &BookQuery {
                        filter: LibraryFilter::Recent,
                        sort: LibrarySort::RecentlyRead,
                        ..Default::default()
                    },
                )
            })
            .expect("list");
        assert!(recent.is_empty(), "没有读过就不该出现在最近里");
    }

    #[test]
    fn deleting_a_book_removes_its_files() {
        let harness = Harness::new("import-delete");
        let source = epub(&harness.dir, "a.epub", "三体");
        harness.import(&[source]);

        let books = harness.shelve();
        let id = books[0].id.clone();
        let (book, cover) = crate::library::book_files(&harness.library, &id).expect("files");
        assert!(book.as_deref().map(Path::exists).unwrap_or(false));
        assert!(cover.as_deref().map(Path::exists).unwrap_or(false));

        crate::library::delete_book(&harness.library, &id).expect("delete");

        assert!(!book.as_deref().map(Path::exists).unwrap_or(false), "书籍文件应被删除");
        assert!(!cover.as_deref().map(Path::exists).unwrap_or(false), "封面文件应被删除");
        assert!(harness.shelve().is_empty());
    }

    #[test]
    fn hashing_streams_without_loading_the_file() {
        let dir = fixture::temp_dir("hash");
        let path = dir.join("big.txt");
        std::fs::write(&path, vec![b'a'; 200 * 1024]).expect("write");

        let hash = sha256_file(&path).expect("hash");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, sha256_file(&path).expect("stable"), "同一内容必须得到同一哈希");
        std::fs::remove_dir_all(&dir).ok();
    }
}
