//! The book's own table of contents: KF8's INDX chains, and MOBI6's guide page.

use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use super::bytes::{be_u16, be_u32};
use super::html;
use super::pdb::Section;
use super::text::decode_text;

/// One chapter boundary taken from the book's own table of contents.
pub(super) struct TocItem {
    /// Byte offset into the decoded text.
    pub(super) offset: usize,
    pub(super) label: String,
}

/// Maps the text's Kindle link targets to byte offsets in the decoded text.
pub(super) enum PosResolver {
    /// KF8 `kindle:pos:fid:X:off:Y`, through the fragment position table.
    Kf8(HashMap<u32, usize>),
    /// MOBI6 `kindle:filepos:N` — N already is the byte offset.
    Filepos,
}

impl PosResolver {
    pub(super) fn resolve(&self, target: &str) -> Option<usize> {
        match self {
            Self::Kf8(positions) => {
                let rest = target.strip_prefix("kindle:pos:fid:")?;
                let (fid, off) = rest.split_once(":off:")?;
                // Both halves are written in base 32 by Amazon's tooling.
                let fid = u32::from_str_radix(fid, 32).ok()?;
                let off = u32::from_str_radix(off, 32).ok()?;
                positions.get(&fid).map(|base| base + off as usize)
            }
            Self::Filepos => {
                target.strip_prefix("kindle:filepos:").and_then(|value| value.parse::<usize>().ok())
            }
        }
    }
}

/// The KF8 table of contents: NCX entries positioned through the skeleton and
/// fragment index tables. Returns chapter boundaries plus the fid → offset
/// table that also resolves `kindle:pos:` links inside the text.
///
/// All record numbers involved are relative to the section's own record 0,
/// which is how Amazon encodes the KF8 part of a combined file.
pub(super) fn kf8_toc(
    records: &[Vec<u8>],
    section: &Section,
) -> Option<(Vec<TocItem>, HashMap<u32, usize>)> {
    let frag = read_index(records, section.record(section.frag)?)?;
    let skel = read_index(records, section.record(section.skel)?)?;
    let ncx = read_index(records, section.record(section.indx)?)?;

    // A skeleton owns the next numFrag fragments in list order; fragment
    // offsets count from the end of the skeleton's own text.
    let mut positions: HashMap<u32, usize> = HashMap::new();
    let mut fragments = frag.entries.iter();
    for skeleton in &skel.entries {
        let count = *skeleton.tags.get(&1)?.first()?;
        let bounds = skeleton.tags.get(&6)?;
        let base = *bounds.first()? as usize + *bounds.get(1)? as usize;
        for _ in 0..count {
            let fragment = fragments.next()?;
            let fid = *fragment.tags.get(&4)?.first()?;
            let offset = *fragment.tags.get(&6)?.first()? as usize;
            positions.insert(fid, base + offset);
        }
    }

    let mut items: Vec<TocItem> = Vec::new();
    for entry in &ncx.entries {
        let pos = entry.tags.get(&6)?;
        let base = *positions.get(pos.first()?)?;
        let label = entry
            .tags
            .get(&3)
            .and_then(|values| values.first())
            .and_then(|key| ncx.cncx.get(key))
            .cloned()
            .unwrap_or_default();
        items.push(TocItem { offset: base + *pos.get(1)? as usize, label });
    }
    items.sort_by_key(|item| item.offset);
    items.dedup_by(|a, b| a.offset == b.offset);
    (items.len() >= 2).then_some((items, positions))
}

/// The MOBI6 table of contents: the guide's `toc` reference points at a page
/// whose `filepos` anchors are the chapter boundaries. Labels arrive later,
/// as the anchor text of the link markers the HTML parser produces.
pub(super) fn mobi6_toc(raw: &str) -> Option<Vec<TocItem>> {
    let guide_start = raw.find("<guide")?;
    let guide_end = guide_start + raw[guide_start..].find("</guide>")?;
    let mut reader = Reader::from_str(&raw[guide_start..guide_end]);
    let mut buf = Vec::new();
    let mut references: Vec<(String, u64)> = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if element.name().local_name().as_ref() == "reference" {
                    let kind = html::attribute(&element, "type");
                    let filepos = html::attribute(&element, "filepos").parse().ok();
                    if let Some(filepos) = filepos {
                        references.push((kind, filepos));
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    let toc_pos = references
        .iter()
        .find(|(kind, _)| kind.to_ascii_lowercase().split_whitespace().any(|token| token == "toc"))?
        .1;
    // The TOC page ends where the next guide destination begins.
    let toc_end = references
        .iter()
        .map(|(_, pos)| *pos)
        .filter(|pos| *pos > toc_pos)
        .min()
        .unwrap_or(u64::MAX);
    let toc_pos = toc_pos.min(raw.len() as u64) as usize;
    let toc_end = toc_end.min(raw.len() as u64) as usize;
    let page = raw.get(toc_pos..toc_end)?;
    // Skip the guide itself: its own filepos attributes must not count as
    // anchors.
    let page = &page[page.find("</guide>").map_or(0, |at| at + "</guide>".len())..];

    let mut found: Vec<usize> = Vec::new();
    let bytes = page.as_bytes();
    let mut at = 0usize;
    while let Some(rel) = page[at..].find("filepos") {
        let mut cursor = at + rel + "filepos".len();
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'=') {
            cursor += 1;
        }
        if matches!(bytes.get(cursor), Some(b'"') | Some(b'\'')) {
            cursor += 1;
        }
        let start = cursor;
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_digit()) {
            cursor += 1;
        }
        if cursor > start
            && let Ok(value) = page[start..cursor].parse()
        {
            found.push(value);
        }
        at = cursor;
    }

    found.sort_unstable();
    found.dedup();
    let items: Vec<TocItem> =
        found.into_iter().map(|offset| TocItem { offset, label: String::new() }).collect();
    (items.len() >= 2).then_some(items)
}

/// The chapter holding `offset`: the last boundary at or before it.
pub(super) fn chapter_index(boundaries: &[usize], offset: usize) -> Option<usize> {
    (!boundaries.is_empty())
        .then(|| boundaries.partition_point(|&bound| bound <= offset).saturating_sub(1))
}

/// One MOBI index entry: the raw values of every tag present. (The entry
/// name matters to frag insert offsets and NCX ordinals; neither is used.)
pub(super) struct IndexEntry {
    pub(super) tags: HashMap<u32, Vec<u32>>,
}

/// One INDX record chain: parsed entries plus the CNCX string pool.
pub(super) struct IndexData {
    pub(super) entries: Vec<IndexEntry>,
    cncx: HashMap<u32, String>,
}

/// Parses an INDX chain: header record with the TAGX tag table, then the entry
/// records, then the CNCX records holding shared strings (TOC labels and the
/// like). Anything malformed aborts the chain; callers fall back.
pub(super) fn read_index(records: &[Vec<u8>], num: usize) -> Option<IndexData> {
    let header = records.get(num)?;
    if header.get(0..4) != Some(b"INDX") {
        return None;
    }
    let header_len = be_u32(header, 4) as usize;
    let record_count = be_u32(header, 24) as usize;
    let encoding = be_u32(header, 28);
    let cncx_count = be_u32(header, 52) as usize;

    let tagx = header.get(header_len..)?;
    if tagx.get(0..4) != Some(b"TAGX") {
        return None;
    }
    let tagx_len = be_u32(tagx, 4) as usize;
    let control_bytes = be_u32(tagx, 8) as usize;
    let table: Vec<(u32, u32, u32, u32)> = (12..tagx_len)
        .step_by(4)
        .filter_map(|at| tagx.get(at..at + 4))
        .map(|row| (u32::from(row[0]), u32::from(row[1]), u32::from(row[2]), u32::from(row[3])))
        .collect();

    // CNCX strings are keyed by byte position within their record, with each
    // record adding a 0x10000 offset to the key space.
    let mut cncx: HashMap<u32, String> = HashMap::new();
    for index in 0..cncx_count {
        let record = records.get(num + record_count + index + 1)?;
        let mut cursor = 0usize;
        while cursor < record.len() {
            // The key is the position of the length byte itself.
            let key = (index * 0x1_0000 + cursor) as u32;
            let Some(length) = read_vwi(record, &mut cursor) else { break };
            let Some(bytes) = record.get(cursor..cursor + length as usize) else { break };
            cursor += length as usize;
            cncx.insert(key, decode_text(bytes, encoding));
        }
    }

    let mut entries = Vec::new();
    for record_index in 0..record_count {
        let Some(record) = records.get(num + 1 + record_index) else { break };
        if record.get(0..4) != Some(b"INDX") {
            break;
        }
        let idxt = be_u32(record, 20) as usize;
        let entry_count = be_u32(record, 24) as usize;
        for entry_index in 0..entry_count {
            let at = idxt + 4 + entry_index * 2;
            if at + 2 > record.len() {
                break;
            }
            let offset = be_u16(record, at) as usize;
            let Some(&name_len) = record.get(offset) else { break };
            let name_len = name_len as usize;
            // The entry name (an ordinal or insert offset) is not consumed
            // by any chain we read; it only separates the control bytes.
            let Some(_) = record.get(offset + 1..offset + 1 + name_len) else { break };
            let start = offset + 1 + name_len;

            // Control bytes flag which tags this entry carries; the table
            // turns each flag into either fixed values or a byte-sliced blob.
            let mut present: Vec<(u32, Option<u32>, Option<u32>, u32)> = Vec::new();
            let mut cursor = start + control_bytes;
            let mut control_slot = 0usize;
            let mut broken = false;
            for &(tag, values, mask, kind) in &table {
                if kind & 1 != 0 {
                    control_slot += 1;
                    continue;
                }
                let Some(&byte) = record.get(start + control_slot) else {
                    broken = true;
                    break;
                };
                let value = u32::from(byte) & mask;
                if value == mask {
                    if mask.count_ones() > 1 {
                        let bytes = read_vwi(record, &mut cursor)?;
                        present.push((tag, None, Some(bytes), values));
                    } else {
                        present.push((tag, Some(1), None, values));
                    }
                } else {
                    present.push((tag, Some(value >> mask.trailing_zeros()), None, values));
                }
            }
            if broken {
                break;
            }

            let mut tags: HashMap<u32, Vec<u32>> = HashMap::new();
            for (tag, count, bytes, values) in present {
                let mut list = Vec::new();
                if let Some(count) = count {
                    for _ in 0..count.saturating_mul(values) {
                        list.push(read_vwi(record, &mut cursor)?);
                    }
                } else if let Some(bytes) = bytes {
                    let mut used = 0usize;
                    while used < bytes as usize {
                        let before = cursor;
                        list.push(read_vwi(record, &mut cursor)?);
                        used += cursor - before;
                    }
                }
                tags.insert(tag, list);
            }
            entries.push(IndexEntry { tags });
        }
    }

    Some(IndexData { entries, cncx })
}

/// Forward variable-width integer: 7 bits per byte, high bit marks the last.
pub(super) fn read_vwi(data: &[u8], cursor: &mut usize) -> Option<u32> {
    let mut value = 0u32;
    loop {
        let byte = *data.get(*cursor)?;
        *cursor += 1;
        value = (value << 7) | u32::from(byte & 0x7f);
        if byte & 0x80 != 0 {
            return Some(value);
        }
    }
}
