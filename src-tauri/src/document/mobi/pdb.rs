//! The Palm database container, and one MOBI section's header.

use std::collections::HashMap;
use std::path::Path;

use crate::document::{BookMetadata, CoverImage};
use crate::error::{AppError, AppResult};

use super::bytes::{be_u16, be_u32};
use super::exth::{
    self, EXTH_ASIN, EXTH_AUTHOR, EXTH_COVER, EXTH_DESCRIPTION, EXTH_ISBN, EXTH_KF8_BOUNDARY,
    EXTH_LANGUAGE, EXTH_PUBLISHER, EXTH_THUMB, EXTH_TITLE,
};
use super::palmdoc::{HuffCdic, palmdoc_decompress, trailing_len};
use super::text::sniff_image;
use super::{
    ABSENT_RECORD, COMPRESSION_HUFFDIC, COMPRESSION_NONE, COMPRESSION_PALMDOC, OFFSET_COMPRESSION,
    OFFSET_ENCODING, OFFSET_ENCRYPTION, OFFSET_EXTH_FLAGS, OFFSET_EXTRA_FLAGS, OFFSET_FIRST_IMAGE,
    OFFSET_FRAG, OFFSET_FULL_NAME, OFFSET_FULL_NAME_LENGTH, OFFSET_HUFFMAN_COUNT,
    OFFSET_HUFFMAN_INDEX, OFFSET_INDX, OFFSET_MOBI_LENGTH, OFFSET_MOBI_MAGIC, OFFSET_SKEL,
    OFFSET_TEXT_RECORDS, PDB_HEADER_LEN, RECORD_INFO_LEN,
};

/// Where the shared image pool starts: record 0's resource start field.
///
/// KF8 headers repeat the field, but real-world dumps (z-library among them)
/// fill their copy with garbage while cover offsets and `kindle:embed` ids
/// keep counting from the first section's pool.
pub(super) fn resource_base(records: &[Vec<u8>]) -> usize {
    records.first().map_or(0, |header| be_u32(header, OFFSET_FIRST_IMAGE) as usize)
}

/// Reads every record of a Palm database into memory.
///
/// Record lengths are implied: a record runs to the next record's offset, and
/// the last one runs to the end of the file.
pub(super) fn read_records(path: &Path) -> AppResult<Vec<Vec<u8>>> {
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
pub(super) struct Section {
    start: usize,
    compression: u16,
    text_records: usize,
    pub(super) encoding: u32,
    extra_flags: u16,
    first_image: usize,
    huffman_index: usize,
    huffman_count: usize,
    /// KF8 index chains, as section-relative record numbers.
    pub(super) indx: u32,
    pub(super) frag: u32,
    pub(super) skel: u32,
    exth: HashMap<u32, Vec<u8>>,
}

impl Section {
    pub(super) fn parse(records: &[Vec<u8>], start: usize) -> AppResult<Self> {
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
            indx: record_field(header, OFFSET_INDX),
            frag: record_field(header, OFFSET_FRAG),
            skel: record_field(header, OFFSET_SKEL),
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
    pub(super) fn preferred(&self, records: &[Vec<u8>]) -> Option<Self> {
        let start = self.exth_u32(EXTH_KF8_BOUNDARY)? as usize;
        if start == 0 || start == self.start {
            return None;
        }
        Section::parse(records, start).ok()
    }

    /// The EXTH block itself lives in [`super::exth`]; these three keep the
    /// call sites in this file reading as they always did.
    fn read_exth(&mut self, header: &[u8], at: usize) {
        self.exth = exth::parse(header, at);
    }

    fn exth_text(&self, kind: u32) -> Option<String> {
        exth::text(&self.exth, kind)
    }

    fn exth_u32(&self, kind: u32) -> Option<u32> {
        exth::number(&self.exth, kind)
    }

    /// Absolute record number for a section-relative KF8 index pointer.
    pub(super) fn record(&self, relative: u32) -> Option<usize> {
        (relative != 0 && relative != ABSENT_RECORD).then(|| self.start + relative as usize)
    }

    pub(super) fn metadata(&self, records: &[Vec<u8>]) -> BookMetadata {
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
            // A Mobipocket book reflows: its length is its text, not its pages.
            page_count: None,
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
    /// Offsets count from the file's shared image pool (record 0's resource
    /// start); some producers instead write offsets that only work against the
    /// section's own copy of the field or as absolute record numbers, so all
    /// three candidates are tried and the one that sniffs as an image wins.
    pub(super) fn cover(&self, records: &[Vec<u8>]) -> Option<CoverImage> {
        let offset = self.exth_u32(EXTH_COVER).or_else(|| self.exth_u32(EXTH_THUMB))?;
        if offset == ABSENT_RECORD {
            return None;
        }
        let offset = offset as usize;
        let base = resource_base(records);
        [base + offset, self.first_image + offset, offset]
            .into_iter()
            .filter(|index| *index < records.len())
            .find_map(|index| {
                sniff_image(&records[index])
                    .map(|extension| CoverImage { extension, bytes: records[index].clone() })
            })
    }

    /// Decodes every text record of the section into one HTML byte buffer.
    pub(super) fn text(&self, records: &[Vec<u8>]) -> AppResult<Vec<u8>> {
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
        Ok(html)
    }
}

/// A section-relative record pointer field; absent pointers are all-bits-set,
/// and headers too short to carry the field report the same.
fn record_field(header: &[u8], at: usize) -> u32 {
    if header.len() >= at + 4 { be_u32(header, at) } else { ABSENT_RECORD }
}
