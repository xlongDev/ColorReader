//! StarDict format: `.ifo` metadata, the `.idx` word index, `.dict` bodies.
//!
//! A StarDict dictionary is a bundle of files sharing one base name. This module
//! is the format half only: it parses and reads, and never decides where the
//! files live (that is [`crate::library::dictionaries`]).
//!
//! The scope is deliberate. 32-bit offsets, one `.dict` body, and text field
//! types. Three shapes are refused rather than rendered wrong, because each one
//! changes how the body has to be split and a wrong guess puts mojibake in the
//! popup instead of an error the reader can act on: 64-bit index offsets,
//! a `sametypesequence` naming more than one type, and a dictionary whose only
//! field type is binary (pictures or sound). Binary fields are also skipped
//! when they ride along with text — the popup renders text; showing the
//! pictures and playing the sounds a dictionary carries is its own feature.

use std::cmp::Ordering;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::library::markup::text_from_markup;

/// The first line of every `.ifo` file.
const IFO_MAGIC: &str = "StarDict's dict ifo file";

/// One index record is `word\0` + a 4-byte offset + a 4-byte length, both
/// big-endian, so everything after the terminator is these 9 bytes.
const ENTRY_TAIL: usize = 9;

/// An entry body larger than this is not a definition, it is a corrupt index
/// claiming a huge length — and allocating it would take the process down.
const MAX_BODY_BYTES: u64 = 4 << 20;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}

fn corrupt(message: impl Into<String>) -> AppError {
    AppError::Message(format!("词典文件已损坏：{}", message.into()))
}

/// Whether a field type carries text the popup can show.
///
/// `m` is plain text, `l` is the same in a legacy locale encoding, `t`/`x`/`y`
/// are pronunciations, `X` an untyped string. Everything else is markup
/// (`g` Pango, `h` HTML, `k` PowerWord XML, `w` MediaWiki) or binary.
fn renders_text(kind: char) -> bool {
    matches!(kind, 'm' | 'l' | 't' | 'x' | 'y' | 'X' | 'g' | 'h' | 'k' | 'w')
}

/// The markup types, whose tags have to come off before display.
fn is_markup(kind: char) -> bool {
    matches!(kind, 'g' | 'h' | 'k' | 'w')
}

/// What the `.ifo` file says about a dictionary.
#[derive(Debug, Clone, PartialEq)]
pub struct Metadata {
    pub bookname: String,
    /// As declared. Real dictionaries are not always honest about it, so it is
    /// carried for display rather than trusted for sizing.
    pub wordcount: u64,
    /// The field types every entry shares, when the dictionary declares them.
    pub sametypesequence: Option<String>,
}

/// Parses the `.ifo` metadata.
pub fn parse_ifo(text: &str) -> AppResult<Metadata> {
    let mut lines = text.lines();
    match lines.next() {
        Some(first) if first.trim() == IFO_MAGIC => {}
        _ => return Err(invalid("这不是 StarDict 词典：缺少 .ifo 标识行")),
    }

    let mut bookname = String::new();
    let mut wordcount = 0u64;
    let mut sametypesequence = None;
    for line in lines {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "bookname" => bookname = value.to_string(),
            "wordcount" => wordcount = value.parse().unwrap_or(0),
            "idxoffsetbits" if value != "32" => {
                return Err(invalid("这本词典使用 64 位索引偏移，暂不支持"));
            }
            "sametypesequence" => sametypesequence = Some(value.to_string()),
            _ => {}
        }
    }

    if bookname.is_empty() {
        return Err(invalid("StarDict 词典没有书名（bookname）"));
    }
    if let Some(types) = &sametypesequence {
        validate_types(types)?;
    }
    Ok(Metadata { bookname, wordcount, sametypesequence })
}

/// Rejects the declared type sequences this reader cannot split correctly.
fn validate_types(types: &str) -> AppResult<()> {
    let mut chars = types.chars();
    let Some(first) = chars.next() else {
        return Err(invalid("sametypesequence 是空的"));
    };
    if chars.next().is_some() {
        return Err(invalid("这本词典的词条包含多种字段类型，暂不支持"));
    }
    if !renders_text(first) {
        return Err(invalid("这本词典的词条不是文本（可能是图片或声音词典），暂不支持"));
    }
    Ok(())
}

/// The start offset of every index entry, in order.
///
/// Four bytes per headword, so a 700k-entry dictionary costs a couple of
/// megabytes here instead of the tens its index would: the index itself stays
/// on disk and is read entry by entry during a lookup.
pub fn entry_offsets(index: &[u8]) -> AppResult<Vec<u32>> {
    let mut offsets = Vec::new();
    let mut position = 0usize;
    while position < index.len() {
        let Some(nul) = index[position..].iter().position(|byte| *byte == 0) else {
            return Err(corrupt("索引里有一条词条没有结束符"));
        };
        let next = position + nul + ENTRY_TAIL;
        if next > index.len() {
            return Err(corrupt("索引最后一条词条不完整"));
        }
        offsets.push(position as u32);
        position = next;
    }
    Ok(offsets)
}

/// One record of the index.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub word: String,
    /// Where this entry's body starts in the `.dict` file.
    pub offset: u64,
    /// How many bytes that body occupies.
    pub size: u64,
}

/// Parses one `.idx` record.
pub fn parse_entry(record: &[u8]) -> AppResult<Entry> {
    let Some(nul) = record.iter().position(|byte| *byte == 0) else {
        return Err(corrupt("词条缺少结束符"));
    };
    let tail = &record[nul + 1..];
    if tail.len() < 8 {
        return Err(corrupt("词条的偏移或长度不完整"));
    }
    Ok(Entry {
        word: String::from_utf8_lossy(&record[..nul]).into_owned(),
        offset: u32::from_be_bytes([tail[0], tail[1], tail[2], tail[3]]) as u64,
        size: u32::from_be_bytes([tail[4], tail[5], tail[6], tail[7]]) as u64,
    })
}

/// A seekable view of one `.idx` file.
///
/// The offsets are handed in rather than computed here so they can be cached
/// per dictionary: they never change, and rebuilding them means rescanning the
/// whole index.
pub struct Index {
    file: File,
    offsets: Arc<Vec<u32>>,
    length: u64,
}

impl Index {
    pub fn open(path: &Path, offsets: Arc<Vec<u32>>) -> AppResult<Self> {
        let file = File::open(path)?;
        let length = file.metadata()?.len();
        Ok(Self { file, offsets, length })
    }

    /// The entry for `word`, by binary search.
    ///
    /// StarDict sorts its index with `strcmp`, which compares bytes as
    /// *unsigned* — Rust orders `[u8]` the same way, so the comparison needs no
    /// translation. Real dictionaries occasionally carry an unsorted tail or a
    /// case-folded index; those entries read as a miss, and the caller retries
    /// lowercased before giving up.
    pub fn find(&mut self, word: &str) -> AppResult<Option<Entry>> {
        let needle = word.as_bytes();
        let (mut low, mut high) = (0usize, self.offsets.len());
        while low < high {
            let middle = low + (high - low) / 2;
            let entry = self.read(middle)?;
            match entry.word.as_bytes().cmp(needle) {
                Ordering::Less => low = middle + 1,
                Ordering::Greater => high = middle,
                Ordering::Equal => return Ok(Some(entry)),
            }
        }
        Ok(None)
    }

    /// Reads entry `index` by slicing between its offset and the next one's.
    fn read(&mut self, index: usize) -> AppResult<Entry> {
        let start = u64::from(self.offsets[index]);
        let end = self.offsets.get(index + 1).map_or(self.length, |next| u64::from(*next));
        let mut record = vec![0u8; (end - start) as usize];
        self.file.seek(SeekFrom::Start(start))?;
        self.file.read_exact(&mut record)?;
        parse_entry(&record)
    }
}

/// Reads one entry's body out of the `.dict` file.
pub fn read_body(path: &Path, entry: &Entry) -> AppResult<Vec<u8>> {
    if entry.size > MAX_BODY_BYTES {
        return Err(corrupt("词条长度不合理"));
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(entry.offset))?;
    let mut body = vec![0u8; entry.size as usize];
    file.read_exact(&mut body)?;
    Ok(body)
}

/// The text of one entry, or `None` when it carries none.
///
/// With a `sametypesequence` the body is already just the payload. Without one
/// each field is preceded by its type byte, and only the first field is read:
/// real entries put their meaning first, and guessing where a following field
/// ends would splice half a word into the popup rather than report a miss.
pub fn decode(body: &[u8], sametypesequence: Option<&str>) -> Option<String> {
    let (kind, payload) = match sametypesequence {
        Some(types) => (types.chars().next()?, body),
        None => {
            let (&kind, payload) = body.split_first()?;
            (char::from(kind), payload)
        }
    };
    render(kind, payload)
}

/// One field as display text.
fn render(kind: char, payload: &[u8]) -> Option<String> {
    // A binary field's bytes are not text: decoding them anyway is how a
    // picture entry ends up painting control characters into the popup.
    if !renders_text(kind) {
        return None;
    }
    let raw = String::from_utf8_lossy(payload);
    let text = if is_markup(kind) { text_from_markup(&raw) } else { raw.into_owned() };
    let trimmed = text.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a real bundle on disk: `<dir>/test.{ifo,idx,dict}`.
    fn bundle(
        dir: &Path,
        entries: &[(&str, &str)],
        sametypesequence: Option<&str>,
    ) -> (String, Vec<u8>) {
        let mut dict = Vec::new();
        let mut index = Vec::new();
        for (word, body) in entries {
            let payload = match sametypesequence {
                Some(_) => body.as_bytes().to_vec(),
                None => {
                    let mut typed = vec![b'm'];
                    typed.extend_from_slice(body.as_bytes());
                    typed
                }
            };
            index.extend_from_slice(word.as_bytes());
            index.push(0);
            index.extend_from_slice(&(dict.len() as u32).to_be_bytes());
            index.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            dict.extend_from_slice(&payload);
        }

        let ifo = format!(
            "{IFO_MAGIC}\nversion=2.4.2\nbookname=测试词典\nwordcount={}\nidxfilesize={}\n{}",
            entries.len(),
            index.len(),
            sametypesequence.map_or(String::new(), |types| format!("sametypesequence={types}\n")),
        );
        std::fs::write(dir.join("test.ifo"), &ifo).expect("ifo");
        std::fs::write(dir.join("test.idx"), &index).expect("idx");
        std::fs::write(dir.join("test.dict"), &dict).expect("dict");
        (ifo, index)
    }

    /// A scratch directory of our own; no `tempfile` dependency for one test.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("colorreader-stardict-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn the_ifo_magic_and_bookname_are_required() {
        assert!(matches!(
            parse_ifo("not a stardict file\nversion=2.4.2"),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(parse_ifo(IFO_MAGIC), Err(AppError::InvalidArgument(_))));
    }

    #[test]
    fn the_ifo_yields_its_metadata() {
        let text = format!(
            "{IFO_MAGIC}\nversion=2.4.2\nbookname=牛津英汉\nwordcount=42\nidxfilesize=100\n\
             sametypesequence=m\ndescription=ignored=value\n"
        );
        let meta = parse_ifo(&text).expect("parse");
        assert_eq!(meta.bookname, "牛津英汉");
        assert_eq!(meta.wordcount, 42);
        assert_eq!(meta.sametypesequence.as_deref(), Some("m"));
    }

    #[test]
    fn shapes_we_cannot_split_are_refused() {
        // 64-bit offsets.
        let wide = format!("{IFO_MAGIC}\nbookname=X\nidxoffsetbits=64\n");
        assert!(matches!(parse_ifo(&wide), Err(AppError::InvalidArgument(_))));

        // More than one field type per entry.
        let mixed = format!("{IFO_MAGIC}\nbookname=X\nsametypesequence=ml\n");
        assert!(matches!(parse_ifo(&mixed), Err(AppError::InvalidArgument(_))));

        // A dictionary with no text in it at all.
        let pictures = format!("{IFO_MAGIC}\nbookname=X\nsametypesequence=P\n");
        assert!(matches!(parse_ifo(&pictures), Err(AppError::InvalidArgument(_))));
    }

    #[test]
    fn offsets_cover_every_record_and_reject_a_truncated_one() {
        let (_, index) = bundle(&scratch("offsets"), &[("a", "one"), ("b", "two")], Some("m"));
        let offsets = entry_offsets(&index).expect("offsets");
        assert_eq!(offsets.len(), 2);
        assert_eq!(offsets[0], 0);
        assert_eq!(offsets[1] as usize, "a".len() + 1 + 8);

        assert!(matches!(entry_offsets(&index[..index.len() - 2]), Err(AppError::Message(_))));
    }

    #[test]
    fn a_lookup_finds_its_body_and_misses_cleanly() {
        let dir = scratch("lookup");
        let (_, index) =
            bundle(&dir, &[("apple", "苹果"), ("hello", "你好"), ("zebra", "斑马")], Some("m"));
        let mut handle =
            Index::open(&dir.join("test.idx"), Arc::new(entry_offsets(&index).expect("offsets")))
                .expect("open");

        for (word, expected) in [("apple", "苹果"), ("hello", "你好"), ("zebra", "斑马")] {
            let entry = handle.find(word).expect("find").expect("词条存在");
            assert_eq!(entry.word, word);
            let body = read_body(&dir.join("test.dict"), &entry).expect("body");
            assert_eq!(decode(&body, Some("m")).as_deref(), Some(expected));
        }

        assert!(handle.find("banana").expect("find").is_none(), "没收录就要是 None");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_declared_sequence_each_body_carries_its_type() {
        let dir = scratch("typed");
        let (_, index) = bundle(&dir, &[("word", "a meaning")], None);
        let mut handle =
            Index::open(&dir.join("test.idx"), Arc::new(entry_offsets(&index).expect("offsets")))
                .expect("open");
        let entry = handle.find("word").expect("find").expect("exists");
        let body = read_body(&dir.join("test.dict"), &entry).expect("body");
        assert_eq!(body[0], b'm', "没有 sametypesequence 时正文自己带类型字节");
        assert_eq!(decode(&body, None).as_deref(), Some("a meaning"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_text_field_reads_as_no_text() {
        assert_eq!(decode(b"", Some("m")), None, "空正文没有文本");
        assert_eq!(decode(&[b'P', 1, 2, 3], None), None, "图片字段不产出文本");
        assert_eq!(decode(b"   ", Some("m")), None, "只有空白等于没有文本");
    }
}
