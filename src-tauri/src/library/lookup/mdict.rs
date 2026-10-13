//! MDict (`.mdx`): the format half, read-only.
//!
//! MDict itself is closed source and there is no official format document, so
//! this follows the reverse-engineered description and is confirmed against a
//! real file: `tests/fixtures/mini.mdx` was written by a third-party writer
//! (`writemdict`, see `scripts/generate-mdx-fixture.py`) and is accepted by a
//! third-party reader, which is what makes the tests evidence rather than a
//! restatement of the assumptions in this module.
//!
//! **The scope is narrowed on purpose**, and each narrowing is refused by name
//! when the header announces it, instead of half-parsing: version **2.0**,
//! encoding **UTF-8**, and **nothing encrypted**. Version 1.2 changes every size
//! field from 8 bytes to 4, the other encodings need GBK/Big5 decoders, and
//! encryption has two separate paths keyed off the reader's mail or device id.
//! Guessing at any of them produces plausible mojibake, which is worse than a
//! refusal. `.mdd` resource bundles are out of scope too: the popup shows text.
//!
//! Three checksums appear in the file, in three different byte orders — the
//! header's is little-endian, the key section's is big-endian, and a block's is
//! big-endian over the *decompressed* data. All three are verified.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

use quick_xml::events::Event;

use crate::document::html::attribute;
use crate::error::{AppError, AppResult};
use crate::library::markup::text_from_markup;

/// The only engine version parsed; 1.2 uses 4-byte size fields throughout.
const ENGINE_VERSION: &str = "2.0";
/// The only encoding parsed; the others need GBK / Big5 decoders.
const ENCODING: &str = "UTF-8";
/// Block compression types the format defines.
const COMPRESSION_NONE: u32 = 0;
const COMPRESSION_ZLIB: u32 = 2;
/// A header or block larger than this is a corrupt field claiming a huge size,
/// and trusting it would take the process down.
const MAX_HEADER_BYTES: u64 = 4 << 20;
const MAX_BLOCK_BYTES: u64 = 32 << 20;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}

fn corrupt(message: impl Into<String>) -> AppError {
    AppError::Message(format!("词典文件已损坏：{}", message.into()))
}

/// What the header says about a dictionary.
#[derive(Debug, Clone, PartialEq)]
pub struct Metadata {
    pub title: String,
    pub description: String,
}

/// Parses the header XML, refusing the shapes this reader cannot parse.
///
/// Split from the file reading so the refusals can be tested without building a
/// file for each one.
pub fn parse_header(text: &str) -> AppResult<Metadata> {
    // Spelled out rather than imported: `Reader` is this module's own type.
    let mut reader = quick_xml::reader::Reader::from_str(text);
    let mut buffer = Vec::new();
    let mut root = None;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                root = Some(element.into_owned());
                break;
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(err) => return Err(invalid(format!("词典头部无法解析：{err}"))),
        }
    }
    let Some(root) = root else {
        return Err(invalid("这不是 MDict 词典：头部没有 XML 标签"));
    };

    let version = attribute(&root, "GeneratedByEngineVersion");
    if version != ENGINE_VERSION {
        return Err(invalid(format!(
            "这本词典是 MDict {version} 格式，本版本只支持 {ENGINE_VERSION}"
        )));
    }
    let encoding = attribute(&root, "Encoding").to_ascii_uppercase();
    if encoding != ENCODING {
        return Err(invalid(format!("这本词典是 {encoding} 编码，本版本只支持 {ENCODING}")));
    }
    let encrypted = attribute(&root, "Encrypted");
    if encrypted != "0" && !encrypted.is_empty() {
        return Err(invalid("这本词典的内容是加密的，本版本不支持"));
    }

    Ok(Metadata { title: attribute(&root, "Title"), description: attribute(&root, "Description") })
}

/// Adler-32, the checksum the format uses for the header, the key section
/// preamble and every block.
fn adler32(bytes: &[u8]) -> u32 {
    const MODULUS: u32 = 65521;
    let (mut low, mut high) = (1u32, 0u32);
    for byte in bytes {
        low = (low + u32::from(*byte)) % MODULUS;
        high = (high + low) % MODULUS;
    }
    (high << 16) | low
}

/// One key block's entry in the key section's index.
#[derive(Debug, Clone, PartialEq)]
struct KeyBlock {
    /// File offset of the block's compressed data.
    offset: u64,
    /// Compressed size, the 8-byte block header included.
    compressed: u64,
    /// The block's first and last keys, which say whether the term lives here.
    /// Both are stored NUL-terminated in the file and without it here.
    first_key: Vec<u8>,
    last_key: Vec<u8>,
}

/// One record block's entry in the record section's index.
#[derive(Debug, Clone, PartialEq)]
struct RecordBlock {
    offset: u64,
    compressed: u64,
    /// The running total of the decompressed sizes of the blocks before this
    /// one. A key stores an offset into the plainly concatenated records, so
    /// this is what turns it back into a block plus an offset inside it.
    starts_at: u64,
    decompressed: u64,
}

/// Everything read once per dictionary: the header and both block indexes.
///
/// Parsed on the first lookup and cached by the registry, so a lookup then
/// opens the file and reads exactly two blocks — one key block and one record
/// block.
#[derive(Debug, Clone, PartialEq)]
pub struct Index {
    pub metadata: Metadata,
    /// Entry count from the key section. The header does not carry it, and the
    /// count a writer stamps elsewhere is not always honest.
    pub wordcount: u64,
    key_blocks: Vec<KeyBlock>,
    records: Vec<RecordBlock>,
}

/// Reads the header and walks both block indexes.
pub fn open_index(path: &Path) -> AppResult<Index> {
    let mut file = File::open(path)?;
    let metadata = read_header(&mut file)?;

    // Key section: a 40-byte preamble, its 4-byte checksum, the compressed block
    // index, then the blocks.
    let mut preamble = [0u8; 40];
    file.read_exact(&mut preamble)?;
    let mut checksum = [0u8; 4];
    file.read_exact(&mut checksum)?;
    if u32::from_be_bytes(checksum) != adler32(&preamble) {
        return Err(corrupt("键区前言校验不对"));
    }
    let wordcount = number(&preamble, 8)?;
    let expected_key_blocks = number(&preamble, 0)?;
    let index_decompressed = number(&preamble, 16)?;
    let index_compressed = number(&preamble, 24)?;
    let blocks_total = number(&preamble, 32)?;

    let index_start = file.stream_position()?;
    let key_blocks_start = index_start + index_compressed;
    let raw_index = read_exact_vec(&mut file, index_compressed)?;
    let plain_index = decompress(&raw_index)?;
    if plain_index.len() as u64 != index_decompressed {
        return Err(corrupt("键块索引解压后的大小不对"));
    }
    let key_blocks = parse_key_index(&plain_index, key_blocks_start)?;
    if key_blocks.len() as u64 != expected_key_blocks {
        return Err(corrupt("键块数量与前言的声明不符"));
    }
    let walked = key_blocks.iter().map(|block| block.compressed).sum::<u64>();
    if walked != blocks_total {
        return Err(corrupt("键块总大小与前言的声明不符"));
    }

    // Record section: a 32-byte preamble, then an *uncompressed* block index.
    let records_start = key_blocks_start + blocks_total;
    file.seek(SeekFrom::Start(records_start))?;
    let mut preamble = [0u8; 32];
    file.read_exact(&mut preamble)?;
    let expected_record_blocks = number(&preamble, 0)?;
    let index_size = number(&preamble, 16)?;
    let blocks_total = number(&preamble, 24)?;
    if index_size % 16 != 0 {
        return Err(corrupt("记录块索引的长度不是 16 的整数倍"));
    }
    let mut raw_index = read_exact_vec(&mut file, index_size)?;
    let records = parse_record_index(&mut raw_index, records_start + 32 + index_size)?;
    if records.len() as u64 != expected_record_blocks {
        return Err(corrupt("记录块数量与前言的声明不符"));
    }
    let walked = records.iter().map(|block| block.compressed).sum::<u64>();
    if walked != blocks_total {
        return Err(corrupt("记录块总大小与前言的声明不符"));
    }

    Ok(Index { metadata, wordcount, key_blocks, records })
}

/// A parsed index plus an open file: everything one lookup needs.
pub struct Reader {
    file: File,
    index: Arc<Index>,
}

impl Reader {
    pub fn open(path: &Path, index: Arc<Index>) -> AppResult<Self> {
        Ok(Self { file: File::open(path)?, index })
    }

    /// The entry for `term`, or `None` when the dictionary does not carry it.
    pub fn lookup(&mut self, term: &str) -> AppResult<Option<String>> {
        let needle = term.as_bytes();
        // Blocks are sorted and do not overlap, so the one whose interval holds
        // the term is the only one that can. A scan is plenty: even a huge
        // dictionary has thousands of blocks, not millions.
        let block = self
            .index
            .key_blocks
            .iter()
            .find(|block| {
                block.first_key.as_slice() <= needle && needle <= block.last_key.as_slice()
            })
            .cloned();
        let Some(block) = block else { return Ok(None) };

        let plain = decompress(&self.read_span(block.offset, block.compressed)?)?;
        let mut cursor = Cursor::new(&plain);
        let mut found = None;
        while !cursor.is_empty() {
            let offset = cursor.number()?;
            let key = cursor.cstring()?;
            if key == needle {
                found = Some(offset);
                break;
            }
        }
        let Some(offset) = found else { return Ok(None) };
        self.read_record(offset)
    }

    /// Reads the record at a logical offset into the concatenated records.
    fn read_record(&mut self, offset: u64) -> AppResult<Option<String>> {
        let block = self
            .index
            .records
            .iter()
            .find(|block| {
                offset >= block.starts_at && offset < block.starts_at + block.decompressed
            })
            .cloned();
        let Some(block) = block else { return Ok(None) };

        let plain = decompress(&self.read_span(block.offset, block.compressed)?)?;
        let rest = &plain[(offset - block.starts_at) as usize..];
        // A record runs to its NUL, which the writer guarantees.
        let end = rest.iter().position(|byte| *byte == 0).unwrap_or(rest.len());
        let text = String::from_utf8_lossy(&rest[..end]);
        // MDX records are HTML when the header says `Format="Html"`; the popup
        // shows text, so the tags come off (which also trims).
        let text = text_from_markup(&text);
        Ok(if text.is_empty() { None } else { Some(text) })
    }

    fn read_span(&mut self, offset: u64, size: u64) -> AppResult<Vec<u8>> {
        if size > MAX_BLOCK_BYTES {
            return Err(corrupt("块长度不合理"));
        }
        self.file.seek(SeekFrom::Start(offset))?;
        read_exact_vec(&mut self.file, size)
    }
}

/// Strips a block's 8-byte preamble and inflates its payload.
///
/// The preamble is a *little-endian* compression type followed by the
/// *big-endian* Adler-32 of the decompressed data — the two ends differ, and
/// getting either wrong reads plausible garbage.
fn decompress(block: &[u8]) -> AppResult<Vec<u8>> {
    if block.len() < 8 {
        return Err(corrupt("块太短，缺少 8 字节头部"));
    }
    let kind = u32::from_le_bytes([block[0], block[1], block[2], block[3]]);
    let expected = u32::from_be_bytes([block[4], block[5], block[6], block[7]]);
    let payload = &block[8..];
    let data = match kind {
        COMPRESSION_NONE => payload.to_vec(),
        COMPRESSION_ZLIB => {
            let mut out = Vec::new();
            flate2::read::ZlibDecoder::new(payload)
                .read_to_end(&mut out)
                .map_err(|err| corrupt(format!("zlib 解压失败：{err}")))?;
            out
        }
        // 1 is LZO, which needs a decoder this build does not carry. Refusing a
        // compression we cannot read is a scope answer, not damage.
        other => {
            return Err(invalid(format!(
                "词典使用了不支持的压缩方式（{other}），本版本只支持 zlib"
            )));
        }
    };
    if adler32(&data) != expected {
        return Err(corrupt("块校验不对"));
    }
    Ok(data)
}

/// Walks the decompressed key block index.
///
/// Each entry is `u64 entries | u16 first key length | first key | NUL | u16
/// last key length | last key | NUL | u64 compressed | u64 decompressed`. The
/// lengths do **not** count the NUL that follows each key, so the parser skips
/// one byte after them.
fn parse_key_index(bytes: &[u8], blocks_start: u64) -> AppResult<Vec<KeyBlock>> {
    let mut cursor = Cursor::new(bytes);
    let mut blocks = Vec::new();
    let mut offset = blocks_start;
    while !cursor.is_empty() {
        cursor.number()?; // entries in this block, only used by writers
        let first_key = cursor.key()?;
        let last_key = cursor.key()?;
        let compressed = cursor.number()?;
        cursor.number()?; // decompressed size: the block header carries it too
        blocks.push(KeyBlock { offset, compressed, first_key, last_key });
        offset += compressed;
    }
    Ok(blocks)
}

/// Walks the record block index, which is plain `(compressed, decompressed)`
/// pairs and is not itself compressed.
fn parse_record_index(bytes: &mut [u8], blocks_start: u64) -> AppResult<Vec<RecordBlock>> {
    let mut cursor = Cursor::new(bytes);
    let mut blocks = Vec::new();
    let mut offset = blocks_start;
    let mut starts_at = 0;
    while !cursor.is_empty() {
        let compressed = cursor.number()?;
        let decompressed = cursor.number()?;
        blocks.push(RecordBlock { offset, compressed, starts_at, decompressed });
        offset += compressed;
        starts_at += decompressed;
    }
    Ok(blocks)
}

/// Reads the header at the start of the file: a 4-byte big-endian length, the
/// XML in UTF-16LE, then its little-endian Adler-32.
fn read_header(file: &mut File) -> AppResult<Metadata> {
    let mut length = [0u8; 4];
    file.read_exact(&mut length)?;
    let length = u64::from(u32::from_be_bytes(length));
    if length == 0 || length > MAX_HEADER_BYTES {
        return Err(corrupt("头部长度不合理"));
    }
    let bytes = read_exact_vec(file, length)?;
    let mut checksum = [0u8; 4];
    file.read_exact(&mut checksum)?;
    if u32::from_le_bytes(checksum) != adler32(&bytes) {
        return Err(corrupt("头部校验不对"));
    }
    // The writer terminates the tag with `\r\n\0`, which the parser ignores.
    let units: Vec<u16> =
        bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    parse_header(&String::from_utf16_lossy(&units))
}

fn read_exact_vec(file: &mut File, count: u64) -> AppResult<Vec<u8>> {
    let mut bytes = vec![0u8; count as usize];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// One big-endian `u64` out of a fixed-size field.
fn number(bytes: &[u8], at: usize) -> AppResult<u64> {
    bytes
        .get(at..at + 8)
        .and_then(|slice| <[u8; 8]>::try_from(slice).ok())
        .map(u64::from_be_bytes)
        .ok_or_else(|| corrupt("数字字段被截断"))
}

/// A bounds-checked cursor over a block's decompressed bytes.
///
/// Written out rather than indexed directly because every field in this format
/// is a length-prefixed slice, and an off-by-one there reads a neighbouring
/// entry instead of failing.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn is_empty(&self) -> bool {
        self.at >= self.bytes.len()
    }

    fn take(&mut self, count: usize) -> AppResult<&'a [u8]> {
        let slice =
            self.bytes.get(self.at..self.at + count).ok_or_else(|| corrupt("字段被截断"))?;
        self.at += count;
        Ok(slice)
    }

    /// A big-endian `u64`, the width every size field uses at version 2.0.
    fn number(&mut self) -> AppResult<u64> {
        let slice = self.take(8)?;
        Ok(u64::from_be_bytes(<[u8; 8]>::try_from(slice).map_err(|_| corrupt("字段被截断"))?))
    }

    /// A `u16` length followed by that many bytes and a NUL the length excludes.
    fn key(&mut self) -> AppResult<Vec<u8>> {
        let slice = self.take(2)?;
        let length = usize::from(u16::from_be_bytes([slice[0], slice[1]]));
        let key = self.take(length)?.to_vec();
        self.take(1)?; // the NUL
        Ok(key)
    }

    /// Bytes up to the next NUL, which is consumed.
    fn cstring(&mut self) -> AppResult<&'a [u8]> {
        let rest = self.bytes.get(self.at..).ok_or_else(|| corrupt("字段被截断"))?;
        let end =
            rest.iter().position(|byte| *byte == 0).ok_or_else(|| corrupt("字符串没有结束符"))?;
        self.at += end + 1;
        Ok(&rest[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture a third-party writer produced; see the module docs.
    fn fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.mdx")
    }

    fn lookup(term: &str) -> Option<String> {
        let path = fixture();
        let index = Arc::new(open_index(&path).expect("索引必须能打开"));
        Reader::open(&path, index).expect("打开").lookup(term).expect("查询")
    }

    #[test]
    fn the_checksum_matches_the_published_vector() {
        // RFC 1950's example, so a wrong modulus or bit order fails here rather
        // than as a mysterious "block checksum" error on a real dictionary.
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        assert_eq!(adler32(b""), 1);
    }

    #[test]
    fn the_header_refuses_the_shapes_we_do_not_parse() {
        let good = r#"<Dictionary GeneratedByEngineVersion="2.0" Encoding="UTF-8" Encrypted="0" Title="T" Description="D"/>"#;
        let metadata = parse_header(good).expect("2.0 / UTF-8 / 未加密要能解析");
        assert_eq!(metadata.title, "T");
        assert_eq!(metadata.description, "D");

        for (header, why) in [
            (
                r#"<Dictionary GeneratedByEngineVersion="1.2" Encoding="UTF-8" Encrypted="0"/>"#,
                "1.2",
            ),
            (r#"<Dictionary GeneratedByEngineVersion="2.0" Encoding="GBK" Encrypted="0"/>"#, "GBK"),
            (
                r#"<Dictionary GeneratedByEngineVersion="2.0" Encoding="UTF-8" Encrypted="2"/>"#,
                "加密",
            ),
        ] {
            assert!(
                matches!(parse_header(header), Err(AppError::InvalidArgument(_))),
                "{why} 必须被拒绝"
            );
        }
    }

    #[test]
    fn the_fixture_reads_the_way_the_oracle_reads_it() {
        let path = fixture();
        let index = open_index(&path).expect("索引必须能打开");
        // The fixture is small enough that the writer split it into several
        // blocks, which is the point: the index walk actually runs.
        assert!(index.key_blocks.len() > 1, "夹具应当有多个键块");
        assert!(index.records.len() > 1, "夹具应当有多个记录块");
        assert_eq!(index.wordcount, 44, "词条数来自键区前言");
        assert_eq!(index.metadata.title, "迷你词典");

        // ASCII keys at both ends of the sort order, a CJK key last, and a
        // word from the middle of a multi-block index.
        assert_eq!(lookup("apple").as_deref(), Some("苹果"));
        assert_eq!(lookup("hello").as_deref(), Some("你好"));
        assert_eq!(lookup("word017").as_deref(), Some("释义 17"));
        assert_eq!(lookup("word040").as_deref(), Some("释义 40"));
        assert_eq!(lookup("踟蹰").as_deref(), Some("犹豫不前"));
    }

    #[test]
    fn a_record_is_html_and_arrives_as_text() {
        assert_eq!(lookup("markup").as_deref(), Some("粗体"));
    }

    #[test]
    fn a_word_the_dictionary_lacks_is_a_miss() {
        assert_eq!(lookup("zzzzqqqq"), None);
        // Between two real keys, and past the last one.
        assert_eq!(lookup("word0175"), None);
        assert_eq!(lookup("zzz"), None);
    }

    #[test]
    fn lzo_is_refused_by_name_and_a_bad_checksum_as_damage() {
        // Compression type 1 is LZO, which this build has no decoder for: a
        // scope refusal, so the reader can say so instead of "corrupt file".
        assert!(matches!(
            decompress(&[1, 0, 0, 0, 0, 0, 0, 0, 9]),
            Err(AppError::InvalidArgument(_))
        ));
        // Uncompressed block whose stored checksum is wrong.
        assert!(matches!(decompress(&[0, 0, 0, 0, 0, 0, 0, 0, b'x']), Err(AppError::Message(_))));
        // An uncompressed block with a correct checksum round-trips.
        let mut stored = vec![0u8, 0, 0, 0];
        stored.extend_from_slice(&adler32(b"x").to_be_bytes());
        stored.push(b'x');
        assert_eq!(decompress(&stored).expect("校验正确"), b"x");
    }
}
