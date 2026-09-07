//! MOBI / AZW3: the Palm database container behind Amazon's formats.
//!
//! A MOBI is a Palm database whose record 0 carries a PalmDOC header, a MOBI
//! header and an EXTH block of metadata; the following records hold the book as
//! one long HTML document, optionally compressed. There is no spine and no
//! chapter table, so headings are the only structure available — the same split
//! a plain-text book gets.
//!
//! Everything here is read straight out of the container: no external parser,
//! no temporary files.

use std::collections::HashMap;
use std::path::Path;

use super::html::{self, chapters_from_blocks};
use super::{BookMetadata, CoverImage, RawChapter};
use crate::error::{AppError, AppResult};

/// Size of the Palm database header, up to and including the record count.
const PDB_HEADER_LEN: usize = 78;

/// One record info entry: offset plus attributes and id.
const RECORD_INFO_LEN: usize = 8;

/// Field offsets inside the section's own record 0. The PalmDOC header occupies
/// the first 16 bytes, the MOBI header starts right after it.
const OFFSET_COMPRESSION: usize = 0;
const OFFSET_TEXT_RECORDS: usize = 8;
const OFFSET_ENCRYPTION: usize = 12;
const OFFSET_MOBI_MAGIC: usize = 16;
const OFFSET_MOBI_LENGTH: usize = 20;
const OFFSET_ENCODING: usize = 28;
const OFFSET_FIRST_IMAGE: usize = 108;
const OFFSET_HUFFMAN_INDEX: usize = 112;
const OFFSET_HUFFMAN_COUNT: usize = 116;
const OFFSET_EXTH_FLAGS: usize = 128;
const OFFSET_FULL_NAME: usize = 84;
const OFFSET_FULL_NAME_LENGTH: usize = 88;
const OFFSET_EXTRA_FLAGS: usize = 242;

const COMPRESSION_NONE: u16 = 1;
const COMPRESSION_PALMDOC: u16 = 2;
const COMPRESSION_HUFFDIC: u16 = 17480;

const ENCODING_UTF8: u32 = 65001;

/// A chapter longer than this is cut at a paragraph boundary. A MOBI is one
/// HTML document with no spine, so a book without headings would otherwise
/// become a single chapter holding the whole text.
const MAX_CHAPTER_CHARS: usize = 24_000;

/// EXTH record types we read.
const EXTH_AUTHOR: u32 = 100;
const EXTH_PUBLISHER: u32 = 101;
const EXTH_DESCRIPTION: u32 = 103;
const EXTH_ISBN: u32 = 104;
const EXTH_ASIN: u32 = 113;
const EXTH_KF8_BOUNDARY: u32 = 121;
const EXTH_COVER: u32 = 201;
const EXTH_THUMB: u32 = 202;
const EXTH_TITLE: u32 = 503;
const EXTH_LANGUAGE: u32 = 524;

pub fn read_metadata(path: &Path) -> AppResult<BookMetadata> {
    let records = read_records(path)?;
    let section = Section::parse(&records, 0)?;
    let section = section.preferred(&records).unwrap_or(section);

    let mut metadata = section.metadata(&records);
    metadata.cover = section.cover(&records);
    Ok(metadata)
}

/// Extracts chapters from the (usually single) HTML document of the book.
pub fn read_chapters(path: &Path) -> AppResult<Vec<RawChapter>> {
    let records = read_records(path)?;
    let section = Section::parse(&records, 0)?;
    let section = section.preferred(&records).unwrap_or(section);

    let html = section.text(&records)?;
    let mut chapters = chapters_from_blocks(html::parse_html(&html, ""));
    split_oversized(&mut chapters);

    if chapters.is_empty() {
        return Err(AppError::Parse("MOBI 正文里没有可读的文字".into()));
    }
    Ok(chapters)
}

/// Splits every chapter longer than [`MAX_CHAPTER_CHARS`] at a paragraph
/// boundary, numbering the parts so the table of contents stays readable.
fn split_oversized(chapters: &mut Vec<RawChapter>) {
    let mut index = 0;
    while index < chapters.len() {
        let total: usize = chapters[index].paragraphs.iter().map(|p| p.chars().count()).sum();
        if total <= MAX_CHAPTER_CHARS {
            index += 1;
            continue;
        }
        let chapter = chapters.remove(index);
        let base = chapter.title.unwrap_or_else(|| format!("第 {} 章", index + 1));
        let mut parts: Vec<RawChapter> = Vec::new();
        let mut current = RawChapter::default();
        let mut size = 0usize;
        for paragraph in chapter.paragraphs {
            let chars = paragraph.chars().count();
            if size + chars > MAX_CHAPTER_CHARS && !current.paragraphs.is_empty() {
                current.title = Some(format!("{base}（{}）", parts.len() + 1));
                parts.push(std::mem::take(&mut current));
                size = 0;
            }
            size += chars;
            current.paragraphs.push(paragraph);
        }
        if !current.paragraphs.is_empty() {
            current.title = Some(format!("{base}（{}）", parts.len() + 1));
            parts.push(current);
        }
        let added = parts.len();
        for (offset, part) in parts.into_iter().enumerate() {
            chapters.insert(index + offset, part);
        }
        index += added;
    }
}

/// Reads every record of a Palm database into memory.
///
/// Record lengths are implied: a record runs to the next record's offset, and
/// the last one runs to the end of the file.
fn read_records(path: &Path) -> AppResult<Vec<Vec<u8>>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < PDB_HEADER_LEN + RECORD_INFO_LEN {
        return Err(AppError::Parse("文件太短，不是有效的 MOBI".into()));
    }
    let count = be_u16(&bytes, 76) as usize;
    if count == 0 {
        return Err(AppError::Parse("MOBI 没有记录".into()));
    }
    let mut offsets = Vec::with_capacity(count + 1);
    for index in 0..count {
        let at = PDB_HEADER_LEN + index * RECORD_INFO_LEN;
        if at + 4 > bytes.len() {
            return Err(AppError::Parse("MOBI 记录表被截断".into()));
        }
        offsets.push(be_u32(&bytes, at) as usize);
    }
    offsets.push(bytes.len());

    let mut records = Vec::with_capacity(count);
    for pair in offsets.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        if end < start || end > bytes.len() {
            return Err(AppError::Parse("MOBI 记录越界".into()));
        }
        records.push(bytes[start..end].to_vec());
    }
    Ok(records)
}

/// One MOBI section: record 0 plus the text records it describes.
///
/// A combined MOBI7 + KF8 file holds two sections; the KF8 one starts at the
/// record named by EXTH 121 and carries its own headers.
struct Section {
    start: usize,
    compression: u16,
    text_records: usize,
    encoding: u32,
    extra_flags: u16,
    first_image: usize,
    huffman_index: usize,
    huffman_count: usize,
    exth: HashMap<u32, Vec<u8>>,
}

impl Section {
    fn parse(records: &[Vec<u8>], start: usize) -> AppResult<Self> {
        let Some(header) = records.get(start) else {
            return Err(AppError::Parse(format!("MOBI 缺少记录 {start}")));
        };
        if header.len() < OFFSET_EXTRA_FLAGS + 2 {
            return Err(AppError::Parse("MOBI 头部被截断".into()));
        }
        if header.get(OFFSET_MOBI_MAGIC..OFFSET_MOBI_MAGIC + 4) != Some(b"MOBI") {
            return Err(AppError::Parse("MOBI 头部缺少标识".into()));
        }
        if be_u16(header, OFFSET_ENCRYPTION) != 0 {
            return Err(AppError::Parse("这本 MOBI 有 DRM，无法读取".into()));
        }

        let mut section = Self {
            start,
            compression: be_u16(header, OFFSET_COMPRESSION),
            text_records: be_u16(header, OFFSET_TEXT_RECORDS) as usize,
            encoding: be_u32(header, OFFSET_ENCODING),
            extra_flags: be_u16(header, OFFSET_EXTRA_FLAGS),
            first_image: be_u32(header, OFFSET_FIRST_IMAGE) as usize,
            huffman_index: be_u32(header, OFFSET_HUFFMAN_INDEX) as usize,
            huffman_count: be_u32(header, OFFSET_HUFFMAN_COUNT) as usize,
            exth: HashMap::new(),
        };

        let exth_at = 16 + be_u32(header, OFFSET_MOBI_LENGTH) as usize;
        if be_u32(header, OFFSET_EXTH_FLAGS) & 0x40 != 0
            && header.get(exth_at..exth_at + 4) == Some(b"EXTH")
        {
            section.read_exth(header, exth_at);
        }
        Ok(section)
    }

    /// The KF8 section of a combined file, when there is one.
    ///
    /// KF8 is the richer markup and the format `.azw3` files are built around,
    /// so it wins when present. Failing to parse it falls back to MOBI7 rather
    /// than failing the book.
    fn preferred(&self, records: &[Vec<u8>]) -> Option<Self> {
        let start = self.exth_u32(EXTH_KF8_BOUNDARY)? as usize;
        if start == 0 || start == self.start {
            return None;
        }
        Section::parse(records, start).ok()
    }

    fn read_exth(&mut self, header: &[u8], at: usize) {
        let count = be_u32(header, at + 8) as usize;
        let mut cursor = at + 12;
        for _ in 0..count {
            if cursor + 8 > header.len() {
                break;
            }
            let kind = be_u32(header, cursor);
            let length = be_u32(header, cursor + 4) as usize;
            if length < 8 || cursor + length > header.len() {
                break;
            }
            let data = header[cursor + 8..cursor + length].to_vec();
            self.exth.entry(kind).or_insert(data);
            cursor += length;
        }
    }

    fn exth_text(&self, kind: u32) -> Option<String> {
        let data = self.exth.get(&kind)?;
        let text = String::from_utf8_lossy(data).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn exth_u32(&self, kind: u32) -> Option<u32> {
        let data = self.exth.get(&kind)?;
        match data.len() {
            4 => Some(be_u32(data, 0)),
            // Some producers store the value as a shorter big-endian integer.
            1..=3 => Some(data.iter().fold(0u32, |acc, byte| (acc << 8) | u32::from(*byte))),
            _ => None,
        }
    }

    fn metadata(&self, records: &[Vec<u8>]) -> BookMetadata {
        let title =
            self.exth_text(EXTH_TITLE).or_else(|| self.full_name(records)).unwrap_or_default();
        BookMetadata {
            title,
            subtitle: None,
            description: self.exth_text(EXTH_DESCRIPTION),
            language: self.exth_text(EXTH_LANGUAGE),
            publisher: self.exth_text(EXTH_PUBLISHER),
            identifier: self.exth_text(EXTH_ISBN).or_else(|| self.exth_text(EXTH_ASIN)),
            authors: self.exth_text(EXTH_AUTHOR).map_or_else(Vec::new, |author| vec![author]),
            cover: None,
        }
    }

    /// The full name stored at the end of record 0, when EXTH carries no title.
    fn full_name(&self, records: &[Vec<u8>]) -> Option<String> {
        let header = records.get(self.start)?;
        let at = be_u32(header, OFFSET_FULL_NAME) as usize;
        let length = be_u32(header, OFFSET_FULL_NAME_LENGTH) as usize;
        let text = String::from_utf8_lossy(header.get(at..at + length)?).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    /// The cover image, taken from the record EXTH 201/202 points at.
    ///
    /// Producers disagree on whether the offset is absolute or relative to the
    /// first image record, so both are tried and the one that sniffs as an
    /// image wins.
    fn cover(&self, records: &[Vec<u8>]) -> Option<CoverImage> {
        let offset = self.exth_u32(EXTH_COVER).or_else(|| self.exth_u32(EXTH_THUMB))? as usize;
        [self.first_image + offset, offset]
            .into_iter()
            .filter_map(|index| records.get(index))
            .find_map(|bytes| {
                sniff_image(bytes).map(|extension| CoverImage { extension, bytes: bytes.clone() })
            })
    }

    /// Decodes every text record of the section into one HTML string.
    fn text(&self, records: &[Vec<u8>]) -> AppResult<String> {
        let mut huffdic = match self.compression {
            COMPRESSION_HUFFDIC => {
                Some(HuffCdic::new(records, self.start, self.huffman_index, self.huffman_count)?)
            }
            COMPRESSION_NONE | COMPRESSION_PALMDOC => None,
            other => return Err(AppError::Parse(format!("不支持的 MOBI 压缩方式：{other}"))),
        };

        let mut html: Vec<u8> = Vec::new();
        for index in self.start + 1..=self.start + self.text_records {
            let Some(record) = records.get(index) else { break };
            let end = record.len().saturating_sub(trailing_len(record, self.extra_flags));
            let body = &record[..end];
            match self.compression {
                COMPRESSION_NONE => html.extend_from_slice(body),
                COMPRESSION_PALMDOC => html.extend_from_slice(&palmdoc_decompress(body)),
                _ => {
                    let decompressor = huffdic
                        .as_mut()
                        .ok_or_else(|| AppError::Parse("缺少 HUFF/CDIC 表".into()))?;
                    html.extend_from_slice(&decompressor.decompress(body));
                }
            }
        }
        if html.is_empty() {
            return Err(AppError::Parse("MOBI 正文为空".into()));
        }
        Ok(decode_text(&html, self.encoding))
    }
}

/// Recognises the image containers MOBI embeds as records.
fn sniff_image(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\x89PNG") {
        Some("png".to_string())
    } else if bytes.starts_with(b"GIF8") {
        Some("gif".to_string())
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpeg".to_string())
    } else {
        None
    }
}

/// Decodes the text with the encoding the MOBI header declares.
///
/// 65001 is UTF-8; everything else is treated as CP-1252, which is what
/// MobiPocket wrote and differs from Latin-1 only in the 0x80–0x9F range.
fn decode_text(bytes: &[u8], encoding: u32) -> String {
    if encoding == ENCODING_UTF8 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    bytes.iter().map(|byte| cp1252(*byte)).collect()
}

/// Maps a byte to its CP-1252 character; the high block is the only range that
/// differs from Latin-1.
fn cp1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}',
        '\u{017D}', '\u{008F}', '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}',
        '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
    ];
    match byte {
        0x80..=0x9f => HIGH[(byte - 0x80) as usize],
        _ => char::from(byte),
    }
}

/// Bytes of trailing data appended to each text record, per the extra flags.
///
/// The entries are stored back to front, each sized by a backward-encoded
/// variable-width integer: entry 16 sits at the very end, entry 1 right after
/// the text. Bit 1 is special and carries multibyte-overlap bytes instead.
///
/// ponytail: derived from the format documentation rather than a sample file,
/// so the result is clamped — a misread can never eat a whole record.
fn trailing_len(record: &[u8], extra_flags: u16) -> usize {
    let mut total = 0usize;
    let mut flags = extra_flags >> 1;
    while flags != 0 {
        if flags & 1 != 0 {
            total += trailing_entry_len(record, record.len().saturating_sub(total));
        }
        flags >>= 1;
    }
    if extra_flags & 1 != 0
        && let Some(last) = record.get(record.len().saturating_sub(total + 1))
    {
        total += usize::from(last & 0x3) + 1;
    }
    total.min(record.len())
}

/// Size of one trailing entry, read as a backward variable-width integer.
fn trailing_entry_len(record: &[u8], mut size: usize) -> usize {
    let mut value = 0u32;
    let mut shift = 0u32;
    loop {
        if size == 0 {
            return value as usize;
        }
        let byte = record[size - 1];
        value |= u32::from(byte & 0x7f) << shift;
        shift += 7;
        if byte & 0x80 != 0 || shift >= 28 {
            return value as usize;
        }
        size -= 1;
    }
}

/// Expands PalmDOC (LZ77) compressed text.
fn palmdoc_decompress(data: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 2);
    let mut index = 0usize;
    while index < data.len() {
        let byte = data[index];
        index += 1;
        match byte {
            // A zero byte means the next byte is a literal.
            0 => {
                if let Some(&next) = data.get(index) {
                    out.push(next);
                }
                index += 1;
            }
            // 1..=8: copy that many following bytes verbatim.
            1..=8 => {
                for _ in 0..byte {
                    match data.get(index) {
                        Some(&next) => {
                            out.push(next);
                            index += 1;
                        }
                        None => break,
                    }
                }
            }
            // 0x09..=0x7f: the byte is itself.
            0x09..=0x7f => out.push(byte),
            // 0x80..=0xbf: a length-distance pair, 11 bits of distance.
            0x80..=0xbf => {
                let Some(&next) = data.get(index) else { break };
                index += 1;
                let pair = (u16::from(byte) << 8) | u16::from(next);
                let distance = ((pair >> 3) & 0x7ff) as usize;
                let length = (pair & 7) as usize + 3;
                if distance == 0 || distance > out.len() {
                    break;
                }
                let from = out.len() - distance;
                for offset in 0..length {
                    let copied = out[from + offset];
                    out.push(copied);
                }
            }
            // 0xc0..=0xff: a space followed by (byte ^ 0x80).
            _ => {
                out.push(b' ');
                out.push(byte ^ 0x80);
            }
        }
    }
    out
}

/// A phrase in the HUFF/CDIC dictionary: literal, or another bitstream.
#[derive(Clone)]
enum Phrase {
    Literal(Vec<u8>),
    Compressed(Vec<u8>),
    Expanded(Vec<u8>),
}

/// HUFF/CDIC decompressor, the compression Amazon actually ships.
///
/// One HUFF record holds the code tables, the following CDIC records hold the
/// phrase dictionary the codes index into.
struct HuffCdic {
    /// Per leading byte: code length, terminal flag, pre-shifted max code.
    table: Vec<(u8, bool, u32)>,
    mincode: Vec<u32>,
    maxcode: Vec<u32>,
    phrases: Vec<Phrase>,
}

impl HuffCdic {
    fn new(
        records: &[Vec<u8>],
        start: usize,
        huffman_index: usize,
        huffman_count: usize,
    ) -> AppResult<Self> {
        let huff = records
            .get(start + huffman_index)
            .ok_or_else(|| AppError::Parse("MOBI 缺少 HUFF 记录".into()))?;
        if huff.len() < 24 || &huff[0..8] != b"HUFF\x00\x00\x00\x18" {
            return Err(AppError::Parse("HUFF 记录头部无效".into()));
        }
        let table_at = be_u32(huff, 8) as usize;
        let bounds_at = be_u32(huff, 12) as usize;
        if huff.len() < table_at + 1024 || huff.len() < bounds_at + 256 {
            return Err(AppError::Parse("HUFF 记录被截断".into()));
        }

        let mut table = Vec::with_capacity(256);
        for index in 0..256 {
            let value = be_u32(huff, table_at + index * 4);
            let length = (value & 0x1f) as u8;
            let terminal = value & 0x80 != 0;
            // Codes are pre-shifted so the decoder compares a 32-bit window
            // against them without normalising.
            let maxcode = if length > 0 {
                ((value >> 8).wrapping_add(1) << (32 - length)).wrapping_sub(1)
            } else {
                0
            };
            table.push((length, terminal, maxcode));
        }

        let mut mincode = vec![0u32];
        let mut maxcode = vec![0u32];
        for length in 1..=32usize {
            let at = bounds_at + (length - 1) * 8;
            mincode.push(be_u32(huff, at) << (32 - length));
            let upper = be_u32(huff, at + 4);
            maxcode.push((upper.wrapping_add(1) << (32 - length)).wrapping_sub(1));
        }

        let mut phrases: Vec<Phrase> = Vec::new();
        for offset in 1..huffman_count {
            let Some(cdic) = records.get(start + huffman_index + offset) else { break };
            if cdic.len() < 16 || &cdic[0..8] != b"CDIC\x00\x00\x00\x10" {
                continue;
            }
            let count = be_u32(cdic, 8) as usize;
            let bits = be_u32(cdic, 12) as usize;
            let entries = (1usize << bits.min(20)).min(count.saturating_sub(phrases.len()));
            if cdic.len() < 16 + entries * 2 {
                break;
            }
            for index in 0..entries {
                let at = 16 + be_u16(cdic, 16 + index * 2) as usize;
                if at + 2 > cdic.len() {
                    break;
                }
                let head = be_u16(cdic, at);
                let length = (head & 0x7fff) as usize;
                let slice = cdic[at + 2..(at + 2 + length).min(cdic.len())].to_vec();
                // High bit set: a literal phrase. Clear: another bitstream.
                phrases.push(if head & 0x8000 != 0 {
                    Phrase::Literal(slice)
                } else {
                    Phrase::Compressed(slice)
                });
            }
        }

        Ok(Self { table, mincode, maxcode, phrases })
    }

    fn decompress(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() * 2);
        self.expand(data, &mut out);
        out
    }

    /// Walks the bitstream, appending phrase after phrase to `out`.
    ///
    /// Codes are read most-significant bit first from a 32-bit window carried in
    /// a 64-bit accumulator; a phrase that is itself a bitstream is expanded
    /// through the same decoder and memoised.
    fn expand(&mut self, data: &[u8], out: &mut Vec<u8>) {
        // Eight spare bytes let the window always read a full u64.
        let mut window = data.to_vec();
        window.extend_from_slice(&[0u8; 8]);

        let mut at = 0usize;
        let mut bits = u64::from_be_bytes(slice8(&window, at));
        let mut shift = 32i32;
        let mut remaining = (data.len() * 8) as i64;

        while remaining > 0 {
            if shift <= 0 {
                at += 4;
                bits = u64::from_be_bytes(slice8(&window, at));
                shift += 32;
            }
            let code = (bits >> shift) as u32;
            let (mut length, terminal, mut maxcode) = self.table[(code >> 24) as usize];
            if !terminal {
                while (length as usize) < self.mincode.len() - 1
                    && code < self.mincode[length as usize]
                {
                    length += 1;
                }
                if (length as usize) < self.maxcode.len() {
                    maxcode = self.maxcode[length as usize];
                }
            }
            shift -= i32::from(length);
            remaining -= i64::from(length);
            // A zero-length code would spin forever; stop instead.
            if remaining < 0 || length == 0 {
                break;
            }
            let index = (maxcode.wrapping_sub(code) >> (32 - length)) as usize;
            let nested = match self.phrases.get(index) {
                Some(Phrase::Compressed(bytes)) => Some(bytes.clone()),
                Some(Phrase::Literal(bytes)) | Some(Phrase::Expanded(bytes)) => {
                    out.extend_from_slice(bytes);
                    None
                }
                None => break,
            };
            if let Some(bytes) = nested {
                let mut expanded = Vec::new();
                self.expand(&bytes, &mut expanded);
                out.extend_from_slice(&expanded);
                if let Some(slot) = self.phrases.get_mut(index) {
                    *slot = Phrase::Expanded(expanded);
                }
            }
        }
    }
}

/// Copies eight bytes starting at `at`, zero-padded past the end.
fn slice8(data: &[u8], at: usize) -> [u8; 8] {
    let mut bytes = [0u8; 8];
    for (slot, value) in bytes.iter_mut().zip(data.get(at..at + 8).unwrap_or(&[])) {
        *slot = *value;
    }
    bytes
}

fn be_u16(data: &[u8], at: usize) -> u16 {
    match data.get(at..at + 2) {
        Some([high, low]) => u16::from_be_bytes([*high, *low]),
        _ => 0,
    }
}

fn be_u32(data: &[u8], at: usize) -> u32 {
    match data.get(at..at + 4) {
        Some(bytes) => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::fixture;

    #[test]
    fn a_palmdoc_match_is_expanded_from_the_output() {
        // "ab" then a pair encoding distance 2, length 3; the copy reads the
        // bytes it has just produced, so it yields "ababa".
        let pair = (2u16 << 3) | 0x8000;
        let data = [b'a', b'b', (pair >> 8) as u8, (pair & 0xff) as u8];
        assert_eq!(palmdoc_decompress(&data), b"ababa");
    }

    #[test]
    fn palmdoc_literals_and_space_pairs_round_trip() {
        assert_eq!(palmdoc_decompress(&[0x00, b'x']), b"x");
        assert_eq!(palmdoc_decompress(&[0x03, b'a', b'b', b'c']), b"abc");
        assert_eq!(palmdoc_decompress(b"hi"), b"hi");
        // 0xc0..=0xff emits a space then the byte with its high bit cleared.
        assert_eq!(palmdoc_decompress(&[0xE1]), b" a");
    }

    #[test]
    fn a_truncated_palmdoc_stream_stops_instead_of_panicking() {
        assert_eq!(palmdoc_decompress(&[0x80]), b"");
        assert_eq!(palmdoc_decompress(&[0x05, b'a']), b"a");
    }

    #[test]
    fn cp1252_keeps_the_smart_punctuation_books_use() {
        assert_eq!(decode_text(&[0x93, 0x94, 0x85], 1252), "\u{201C}\u{201D}\u{2026}");
        assert_eq!(decode_text("中".as_bytes(), ENCODING_UTF8), "中");
    }

    #[test]
    fn trailing_lengths_read_backwards_and_never_exceed_the_record() {
        // One trailing entry of size 2, encoded backwards with its stop bit.
        assert_eq!(trailing_len(b"text\x82", 0b10), 2);
        assert_eq!(trailing_len(b"text\x82", 0), 0);
        assert!(trailing_len(b"\x82", 0b10) <= 1, "结果必须被夹在记录长度内");
    }

    #[test]
    fn oversized_chapters_are_split_at_paragraphs() {
        // Three paragraphs that only fit two per part: the third spills over.
        let paragraph = "字".repeat(MAX_CHAPTER_CHARS * 2 / 3);
        let mut chapters = vec![RawChapter {
            title: Some("第一章".into()),
            paragraphs: vec![paragraph.clone(), paragraph.clone(), paragraph.clone()],
        }];
        split_oversized(&mut chapters);

        assert_eq!(chapters.len(), 3, "{:?}", chapters.iter().map(|c| c.title.clone()));
        assert_eq!(chapters[0].title.as_deref(), Some("第一章（1）"));
        assert_eq!(chapters[2].title.as_deref(), Some("第一章（3）"));
        assert!(chapters.iter().all(|chapter| {
            chapter.paragraphs.iter().map(|paragraph| paragraph.chars().count()).sum::<usize>()
                <= MAX_CHAPTER_CHARS
        }));
    }

    #[test]
    fn short_chapters_are_left_alone() {
        let mut chapters =
            vec![RawChapter { title: Some("甲".into()), paragraphs: vec!["短".into()] }];
        split_oversized(&mut chapters);
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title.as_deref(), Some("甲"));
    }

    /// Builds a Palm database with the given records and no valid book inside.
    fn build_pdb(records: &[&[u8]]) -> Vec<u8> {
        let mut out = vec![0u8; PDB_HEADER_LEN];
        let count = records.len() as u16;
        out[76..78].copy_from_slice(&count.to_be_bytes());
        let mut at = PDB_HEADER_LEN + records.len() * RECORD_INFO_LEN;
        let mut offsets = Vec::new();
        for record in records {
            offsets.push(at as u32);
            at += record.len();
        }
        for offset in offsets {
            out.extend_from_slice(&offset.to_be_bytes());
            out.extend_from_slice(&[0u8; 4]);
        }
        for record in records {
            out.extend_from_slice(record);
        }
        out
    }

    #[test]
    fn records_are_split_at_the_declared_offsets() {
        let dir = fixture::temp_dir("mobi-records");
        let path = dir.join("book.mobi");
        std::fs::write(&path, build_pdb(&[b"aa", b"bbb"])).expect("write");

        let records = read_records(&path).expect("records");
        assert_eq!(records, [b"aa".to_vec(), b"bbb".to_vec()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_that_is_not_a_mobi_is_rejected_cleanly() {
        let dir = fixture::temp_dir("mobi-bad");
        let path = dir.join("book.mobi");
        std::fs::write(&path, b"not a palm database, not at all").expect("write");

        assert!(read_chapters(&path).is_err());
        assert!(read_metadata(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Record 0 of an uncompressed, unencrypted MOBI with an EXTH block:
    /// PalmDOC header, MOBI header, then the metadata records.
    fn mobi_header(exth: &[(u32, &str)]) -> Vec<u8> {
        let body: Vec<Vec<u8>> = exth
            .iter()
            .map(|(kind, value)| {
                let mut entry = (kind.to_be_bytes()).to_vec();
                entry.extend_from_slice(&((value.len() + 8) as u32).to_be_bytes());
                entry.extend_from_slice(value.as_bytes());
                entry
            })
            .collect();
        let body_len: usize = body.iter().map(Vec::len).sum();

        let mut block = b"EXTH".to_vec();
        block.extend_from_slice(&((body_len + 12) as u32).to_be_bytes());
        block.extend_from_slice(&(exth.len() as u32).to_be_bytes());
        for entry in body {
            block.extend_from_slice(&entry);
        }

        let mut out = vec![0u8; 16 + 232];
        out[OFFSET_COMPRESSION..OFFSET_COMPRESSION + 2]
            .copy_from_slice(&COMPRESSION_NONE.to_be_bytes());
        out[OFFSET_TEXT_RECORDS..OFFSET_TEXT_RECORDS + 2].copy_from_slice(&1u16.to_be_bytes());
        out[OFFSET_MOBI_MAGIC..OFFSET_MOBI_MAGIC + 4].copy_from_slice(b"MOBI");
        out[OFFSET_MOBI_LENGTH..OFFSET_MOBI_LENGTH + 4].copy_from_slice(&232u32.to_be_bytes());
        out[OFFSET_ENCODING..OFFSET_ENCODING + 4].copy_from_slice(&ENCODING_UTF8.to_be_bytes());
        // No Huffman table and no image records: both indices are "absent".
        out[OFFSET_HUFFMAN_INDEX..OFFSET_HUFFMAN_COUNT + 4].copy_from_slice(&[0xff; 8]);
        out[OFFSET_EXTH_FLAGS..OFFSET_EXTH_FLAGS + 4].copy_from_slice(&0x40u32.to_be_bytes());
        out.extend_from_slice(&block);
        out
    }

    #[test]
    fn a_complete_book_reads_its_metadata_and_heading_chapters() {
        let dir = fixture::temp_dir("mobi-book");
        let path = dir.join("book.mobi");
        let html =
            "<html><body><h1>第一章</h1><p>第一段</p><h1>第二章</h1><p>第二段</p></body></html>";
        std::fs::write(
            &path,
            build_pdb(&[
                &mobi_header(&[
                    (EXTH_TITLE, "MOBI 书名"),
                    (EXTH_AUTHOR, "某作者"),
                    (EXTH_LANGUAGE, "zh"),
                ]),
                html.as_bytes(),
            ]),
        )
        .expect("write");

        let chapters = read_chapters(&path).expect("chapters");
        assert_eq!(chapters.len(), 2, "{chapters:?}");
        // The heading stays as the chapter's first line, as it does for EPUB.
        assert_eq!(chapters[0].title.as_deref(), Some("第一章"));
        assert_eq!(chapters[0].paragraphs, ["第一章", "第一段"]);
        assert_eq!(chapters[1].paragraphs, ["第二章", "第二段"]);

        let metadata = read_metadata(&path).expect("metadata");
        assert_eq!(metadata.title, "MOBI 书名");
        assert_eq!(metadata.authors, ["某作者"]);
        assert_eq!(metadata.language.as_deref(), Some("zh"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_encrypted_book_is_named_in_the_error() {
        let dir = fixture::temp_dir("mobi-drm");
        let path = dir.join("book.mobi");
        let mut header = mobi_header(&[]);
        header[OFFSET_ENCRYPTION..OFFSET_ENCRYPTION + 2].copy_from_slice(&2u16.to_be_bytes());
        std::fs::write(&path, build_pdb(&[&header, b"<p>x</p>"])).expect("write");

        let err = read_chapters(&path).expect_err("DRM 必须被拒绝");
        assert!(err.to_string().contains("DRM"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn image_records_are_recognised_by_their_magic_bytes() {
        assert_eq!(sniff_image(b"\x89PNG\r\n"), Some("png".into()));
        assert_eq!(sniff_image(b"\xff\xd8\xff\xe0"), Some("jpeg".into()));
        assert_eq!(sniff_image(b"GIF89a"), Some("gif".into()));
        assert_eq!(sniff_image(b"<html>"), None);
    }
}
