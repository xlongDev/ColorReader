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

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use super::html::{self, chapter_from_blocks, chapters_from_blocks};
use super::{
    BookMetadata, CoverImage, LINK_FIELD_SEPARATOR, LINK_PARAGRAPH_PREFIX, RawChapter,
    WALLPAPER_PARAGRAPH_PREFIX,
};
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
const OFFSET_INDX: usize = 244;
const OFFSET_FRAG: usize = 248;
const OFFSET_SKEL: usize = 252;

/// Marker for "this record pointer is not set". Record 0 would be ambiguous.
const ABSENT_RECORD: u32 = u32::MAX;

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
///
/// The book's own table of contents wins over heading heuristics: KF8 ships an
/// NCX index and MOBI6 a guide page full of `filepos` anchors. Both reduce to
/// sorted byte offsets into the decoded text, which slice it into chapters;
/// links inside the text are rewritten to jump to the chapter they land in.
pub fn read_chapters(path: &Path) -> AppResult<Vec<RawChapter>> {
    let records = read_records(path)?;
    let section = Section::parse(&records, 0)?;
    let section = section.preferred(&records).unwrap_or(section);

    let raw_bytes = section.text(&records)?;
    let raw = decode_text(&raw_bytes, section.encoding);

    let toc = kf8_toc(&records, &section)
        .map(|(items, positions)| (items, PosResolver::Kf8(positions)))
        .or_else(|| mobi6_toc(&raw).map(|items| (items, PosResolver::Filepos)));

    let mut chapters = Vec::new();
    match toc {
        Some((items, resolver)) if items.len() >= 2 => {
            // A boundary starts a chapter; each slice keeps its markers so
            // the TOC page's anchors turn into working in-book links.
            let mut kept = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let start = item.offset.min(raw_bytes.len());
                let end = items[index + 1..]
                    .iter()
                    .map(|next| next.offset.min(raw_bytes.len()))
                    .find(|end| *end > start)
                    .unwrap_or(raw_bytes.len());
                let text = decode_text(&raw_bytes[start..end], section.encoding);
                let prepared = match &resolver {
                    // Slicing shifts byte offsets, so MOBI6 filepos anchors
                    // are rewritten per slice, not for the whole text.
                    PosResolver::Filepos => link_filepos(&text),
                    PosResolver::Kf8(_) => text,
                };
                let mut chapter =
                    chapter_from_blocks(html::parse_html(&rewrite_recindex(&prepared), ""));
                // The slice's `<body>` class paints its page (part-title art,
                // the copyright page's paper); surface it as a wallpaper
                // marker the reader renders behind the text.
                let backgrounds = flow_backgrounds(&raw, start);
                chapter.paragraphs.splice(0..0, backgrounds);
                if !item.label.is_empty() {
                    chapter.title = Some(item.label.clone());
                }
                if chapter.title.is_none() && chapter.paragraphs.is_empty() {
                    continue;
                }
                chapters.push(chapter);
                kept.push(index);
            }

            let resolver = &resolver;
            // MOBI6 labels come from the anchor text on the TOC page, which
            // only exists as link markers after parsing.
            if matches!(resolver, PosResolver::Filepos) {
                let mut titles: HashMap<usize, String> = HashMap::new();
                for chapter in &chapters {
                    for paragraph in &chapter.paragraphs {
                        if let Some(payload) = paragraph.strip_prefix(LINK_PARAGRAPH_PREFIX)
                            && let Some((target, text)) = payload.split_once(LINK_FIELD_SEPARATOR)
                            && let Some(offset) = resolver.resolve(target)
                        {
                            titles.entry(offset).or_insert_with(|| text.to_string());
                        }
                    }
                }
                for (slot, &index) in kept.iter().enumerate() {
                    if chapters[slot].title.is_none()
                        && let Some(title) = titles.get(&items[index].offset)
                    {
                        chapters[slot].title = Some(title.clone());
                    }
                }
            }

            let boundaries: Vec<usize> = kept.iter().map(|&index| items[index].offset).collect();
            resolve_links(&mut chapters, resolver, &boundaries);
        }
        _ => chapters = chapters_from_blocks(html::parse_html(&raw, "")),
    }

    split_oversized(&mut chapters);

    if chapters.is_empty() {
        return Err(AppError::Parse("MOBI 正文里没有可读的文字".into()));
    }
    Ok(chapters)
}

/// Raw bytes of one image record, addressed by the reference stored in image
/// paragraphs. Both spellings are 1-based and count from the resource pool
/// named by record 0's resource start field — the shared pool that both the
/// MOBI6 and KF8 parts of a combined file reference:
///
/// - `kindle:embed:NN` comes from link targets; ids are base 32.
/// - `kindle:recindex:NNN` comes from `<img recindex>` attributes; ids are
///   decimal, exactly the digits kindlegen writes into the attribute.
pub fn read_asset(path: &Path, asset: &str) -> AppResult<Vec<u8>> {
    let id = if let Some(id) = asset.strip_prefix("kindle:recindex:") {
        id.split('?').next().and_then(|rest| rest.parse::<u32>().ok())
    } else if let Some(id) = asset.strip_prefix("kindle:embed:") {
        id.split('?').next().and_then(|rest| u32::from_str_radix(rest, 32).ok())
    } else {
        None
    }
    .filter(|id| *id > 0)
    .ok_or_else(|| AppError::Parse(format!("无法识别的 MOBI 资源：{asset}")))?;
    let records = read_records(path)?;
    let index = resource_base(&records) + id as usize - 1;
    let record =
        records.get(index).ok_or_else(|| AppError::Parse(format!("MOBI 资源记录越界：{asset}")))?;
    Ok(record.clone())
}

/// Renames Kindle's `recindex` image attribute into a `src` the shared HTML
/// parser understands.
///
/// KF8 marks illustrations with `<img recindex="00047">`: a 1-based decimal
/// record number into the shared resource pool, with no `src` at all. The
/// parser only reads `src`/`href`, so the attribute is renamed in place to
/// `src="kindle:recindex:00047"`. `lowrecindex` is a different attribute that
/// contains the same letters, hence the alphanumeric boundary guard.
fn rewrite_recindex(html: &str) -> Cow<'_, str> {
    const NEEDLE: &str = "recindex=\"";
    let mut out = String::new();
    let mut rest = html;
    while let Some(at) = rest.find(NEEDLE) {
        if rest[..at].chars().next_back().is_some_and(|char| char.is_ascii_alphanumeric()) {
            // Part of a longer attribute name; copy it verbatim.
            out.push_str(&rest[..at + NEEDLE.len()]);
            rest = &rest[at + NEEDLE.len()..];
            continue;
        }
        let value_at = at + NEEDLE.len();
        let Some(value_len) = rest[value_at..].find('"') else { break };
        out.push_str(&rest[..at]);
        out.push_str("src=\"kindle:recindex:");
        out.push_str(&rest[value_at..value_at + value_len]);
        out.push('"');
        rest = &rest[value_at + value_len + 1..];
    }
    if out.is_empty() {
        return Cow::Borrowed(html);
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// The wallpaper marker for a slice, taken from its `<body>` class.
///
/// Kindle paints whole pages with `background-image: url(kindle:embed:N…)`
/// inside a linked flow — no `<img>` anywhere in the document text, so the
/// shared parser sees nothing. The wallpaper belongs to the page's own
/// `<body class=…>` rule; other rules in the same stylesheet paint other
/// pages (the copyright page, fonts), so collecting every url in sight pulled
/// in a stranger's wallpaper and showed a near-white texture page that read
/// as blank. KF8 assembles documents from skeleton fragments, which puts the
/// `<body>` tag just before the slice, so the class is looked up in the raw
/// text behind `slice_start`. Every slice gets its marker: part-title pages
/// show the art alone, text pages (the copyright page) read off the paper.
fn flow_backgrounds(raw: &str, slice_start: usize) -> Vec<String> {
    const BODY_CLASS: &str = "<body class=\"";
    const URL_PREFIX: &str = "url(kindle:embed:";
    let Some(at) = raw[..slice_start].rfind(BODY_CLASS) else { return Vec::new() };
    let from = at + BODY_CLASS.len();
    let Some(class_len) = raw[from..].find('"') else { return Vec::new() };
    let class = &raw[from..from + class_len];
    // The class's declaration block: the first ".class" occurrence whose next
    // character opens a block (".calibre3" must not match ".calibre31").
    let mut cursor = 0usize;
    let block = loop {
        let Some(found) = raw[cursor..].find(&format!(".{class}")) else { return Vec::new() };
        let after = cursor + found + class.len() + 1;
        if raw[after..].trim_start().starts_with('{') {
            let block = &raw[after..];
            let Some(block_end) = block.find('}') else { return Vec::new() };
            break &block[..block_end];
        }
        cursor = after;
    };
    let Some(found) = block.find(URL_PREFIX) else { return Vec::new() };
    let rest = &block[found + URL_PREFIX.len()..];
    let id: &str = rest.split(['?', ')']).next().unwrap_or("");
    // Flows also reference fonts as bare `url(kindle:embed:N)` inside
    // @font-face; real artwork always declares its mime.
    let Some(mime) = rest
        .split("mime=")
        .nth(1)
        .and_then(|tail| tail.split(')').next())
        .filter(|mime| mime.starts_with("image/"))
    else {
        return Vec::new();
    };
    vec![format!("{WALLPAPER_PARAGRAPH_PREFIX}kindle:embed:{id}?mime={mime}")]
}

/// Where the shared image pool starts: record 0's resource start field.
///
/// KF8 headers repeat the field, but real-world dumps (z-library among them)
/// fill their copy with garbage while cover offsets and `kindle:embed` ids
/// keep counting from the first section's pool.
fn resource_base(records: &[Vec<u8>]) -> usize {
    records.first().map_or(0, |header| be_u32(header, OFFSET_FIRST_IMAGE) as usize)
}

/// One chapter boundary taken from the book's own table of contents.
struct TocItem {
    /// Byte offset into the decoded text.
    offset: usize,
    label: String,
}

/// Maps the text's Kindle link targets to byte offsets in the decoded text.
enum PosResolver {
    /// KF8 `kindle:pos:fid:X:off:Y`, through the fragment position table.
    Kf8(HashMap<u32, usize>),
    /// MOBI6 `kindle:filepos:N` — N already is the byte offset.
    Filepos,
}

impl PosResolver {
    fn resolve(&self, target: &str) -> Option<usize> {
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
fn kf8_toc(records: &[Vec<u8>], section: &Section) -> Option<(Vec<TocItem>, HashMap<u32, usize>)> {
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
fn mobi6_toc(raw: &str) -> Option<Vec<TocItem>> {
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

/// Rewrites MOBI6 `filepos` anchor attributes into internal links the shared
/// HTML parser understands. Kindle anchors never carry a real href alongside,
/// so the attribute name is replaced in place; anything unparseable stays.
fn link_filepos(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() + 64);
    let mut at = 0usize;
    while let Some(rel) = html[at..].find("filepos") {
        let hit = at + rel;
        out.push_str(&html[at..hit]);
        let mut cursor = hit + "filepos".len();
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'=') {
            cursor += 1;
        }
        let quoted = matches!(bytes.get(cursor), Some(b'"') | Some(b'\''));
        if quoted {
            cursor += 1;
        }
        let start = cursor;
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_digit()) {
            cursor += 1;
        }
        if cursor == start {
            out.push_str("filepos");
            at = hit + "filepos".len();
            continue;
        }
        out.push_str(&format!("href=\"kindle:filepos:{}\"", &html[start..cursor]));
        at = cursor + usize::from(quoted);
    }
    out.push_str(&html[at..]);
    out
}

/// Rewrites in-book link markers to chapter indices; anything the position
/// tables cannot explain degrades to its plain text.
fn resolve_links(chapters: &mut [RawChapter], resolver: &PosResolver, boundaries: &[usize]) {
    for chapter in chapters {
        for paragraph in &mut chapter.paragraphs {
            let Some(payload) = paragraph.strip_prefix(LINK_PARAGRAPH_PREFIX) else { continue };
            let Some((target, text)) = payload.split_once(LINK_FIELD_SEPARATOR) else { continue };
            let resolved =
                resolver.resolve(target).and_then(|offset| chapter_index(boundaries, offset));
            *paragraph = match resolved {
                Some(index) => {
                    format!("{LINK_PARAGRAPH_PREFIX}{index}{LINK_FIELD_SEPARATOR}{text}")
                }
                None => text.to_string(),
            };
        }
    }
}

/// The chapter holding `offset`: the last boundary at or before it.
fn chapter_index(boundaries: &[usize], offset: usize) -> Option<usize> {
    (!boundaries.is_empty())
        .then(|| boundaries.partition_point(|&bound| bound <= offset).saturating_sub(1))
}

/// One MOBI index entry: the raw values of every tag present. (The entry
/// name matters to frag insert offsets and NCX ordinals; neither is used.)
struct IndexEntry {
    tags: HashMap<u32, Vec<u32>>,
}

/// One INDX record chain: parsed entries plus the CNCX string pool.
struct IndexData {
    entries: Vec<IndexEntry>,
    cncx: HashMap<u32, String>,
}

/// Parses an INDX chain: header record with the TAGX tag table, then the entry
/// records, then the CNCX records holding shared strings (TOC labels and the
/// like). Anything malformed aborts the chain; callers fall back.
fn read_index(records: &[Vec<u8>], num: usize) -> Option<IndexData> {
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
fn read_vwi(data: &[u8], cursor: &mut usize) -> Option<u32> {
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
    /// KF8 index chains, as section-relative record numbers.
    indx: u32,
    frag: u32,
    skel: u32,
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

    /// Absolute record number for a section-relative KF8 index pointer.
    fn record(&self, relative: u32) -> Option<usize> {
        (relative != 0 && relative != ABSENT_RECORD).then(|| self.start + relative as usize)
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
    /// Offsets count from the file's shared image pool (record 0's resource
    /// start); some producers instead write offsets that only work against the
    /// section's own copy of the field or as absolute record numbers, so all
    /// three candidates are tried and the one that sniffs as an image wins.
    fn cover(&self, records: &[Vec<u8>]) -> Option<CoverImage> {
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
    fn text(&self, records: &[Vec<u8>]) -> AppResult<Vec<u8>> {
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

    #[test]
    fn recindex_becomes_a_src_and_lowrecindex_is_left_alone() {
        let html = concat!(
            "<p><img align=\"baseline\" recindex=\"00047\"></p>",
            "<img lowrecindex=\"9\">",
            "<img recindex=\"3\" href=\"kindle:filepos:45\">",
        );
        let expected = concat!(
            "<p><img align=\"baseline\" src=\"kindle:recindex:00047\"></p>",
            "<img lowrecindex=\"9\">",
            "<img src=\"kindle:recindex:3\" href=\"kindle:filepos:45\">",
        );
        assert_eq!(rewrite_recindex(html), expected);
        // Nothing to do: the input is returned untouched, no allocation.
        assert_eq!(rewrite_recindex("<p>正文</p>"), Cow::Borrowed("<p>正文</p>"));
    }

    #[test]
    fn a_rewritten_recindex_image_becomes_a_marker_paragraph() {
        let blocks = html::parse_html(
            &rewrite_recindex("<html><body><img align=\"baseline\" recindex=\"5\"></body></html>"),
            "",
        );
        assert_eq!(blocks, [html::Block::Paragraph("\u{FFFC}kindle:recindex:5".into())]);
    }

    #[test]
    fn body_class_picks_its_own_wallpaper_and_nothing_else() {
        let raw = concat!(
            "<style>.copy{background-image: url(kindle:embed:0006?mime=image/jpeg)}",
            ".fen{background-image: url(kindle:embed:0005?mime=image/jpeg)}",
            ".k1{border: 1px}</style>",
            "<body class=\"copy\"></body></html>版权页",
            "<body class=\"fen\"></body></html>",
            "<div class=\"k\"><div class=\"k1\"><h1>第一部</h1></div></div>",
        );
        // The part page's body class is the one just before its slice; only
        // that rule's wallpaper is surfaced, never a sibling page's.
        let part_at = raw.find("<div class=\"k\"").expect("part slice");
        assert_eq!(flow_backgrounds(raw, part_at), ["\u{FFFA}kindle:embed:0005?mime=image/jpeg"]);
        // An offset inside the copyright page resolves to its own wallpaper.
        let copy_at = raw.find("版权页").expect("copyright slice");
        assert_eq!(flow_backgrounds(raw, copy_at), ["\u{FFFA}kindle:embed:0006?mime=image/jpeg"]);
        // No body class in sight, no marker.
        assert!(flow_backgrounds("<p>正文</p>", 0).is_empty());
    }

    #[test]
    fn read_asset_resolves_recindex_against_the_shared_pool() {
        let dir = fixture::temp_dir("mobi-asset");
        let path = dir.join("book.mobi");
        let mut header = mobi_header(&[]);
        // The pool starts at record 2; recindex ids count from it, 1-based.
        header[OFFSET_FIRST_IMAGE..OFFSET_FIRST_IMAGE + 4].copy_from_slice(&2u32.to_be_bytes());
        std::fs::write(&path, build_pdb(&[&header, b"junk", b"\xff\xd8\xff\xe0jpeg"]))
            .expect("write");

        assert_eq!(
            read_asset(&path, "kindle:recindex:1").expect("recindex"),
            b"\xff\xd8\xff\xe0jpeg".to_vec()
        );
        assert!(read_asset(&path, "kindle:recindex:9").is_err());
        assert!(read_asset(&path, "not-a-reference").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- the book's own table of contents ---

    /// Encodes a forward variable-width integer, high bit on the last byte.
    fn write_vwi(out: &mut Vec<u8>, value: u32) {
        let mut groups = [0u8; 5];
        for (index, group) in groups.iter_mut().enumerate() {
            *group = ((value >> (7 * (4 - index))) & 0x7f) as u8;
        }
        let first = groups.iter().position(|group| *group != 0).unwrap_or(4);
        out.extend_from_slice(&groups[first..4]);
        out.push(groups[4] | 0x80);
    }

    /// Builds INDX records: a header whose TAGX table declares tags
    /// 1, 3, 4 (one value each) and 6 (two values), one control byte.
    type EntrySet = Vec<(u32, Vec<u32>)>;

    fn indx_chain(entry_sets: Vec<Vec<(&str, EntrySet)>>) -> Vec<Vec<u8>> {
        let tags: [[u8; 4]; 5] =
            [[1, 1, 1, 0], [3, 1, 2, 0], [4, 1, 4, 0], [6, 2, 8, 0], [0, 0, 0, 1]];
        let mut first = vec![0u8; 192];
        first[0..4].copy_from_slice(b"INDX");
        first[4..8].copy_from_slice(&192u32.to_be_bytes());
        first[24..28].copy_from_slice(&(entry_sets.len() as u32).to_be_bytes());
        first[28..32].copy_from_slice(&65001u32.to_be_bytes());
        let mut tagx = b"TAGX".to_vec();
        tagx.extend_from_slice(&(12 + 4 * tags.len() as u32).to_be_bytes());
        tagx.extend_from_slice(&1u32.to_be_bytes());
        for row in tags {
            tagx.extend_from_slice(&row);
        }
        first.extend_from_slice(&tagx);
        let mut records = vec![first];

        for entries in entry_sets {
            let mut record = vec![0u8; 192];
            record[0..4].copy_from_slice(b"INDX");
            record[4..8].copy_from_slice(&192u32.to_be_bytes());
            let mut offsets = Vec::new();
            let mut body = Vec::new();
            for (name, tag_values) in &entries {
                offsets.push(192 + body.len());
                body.push(name.len() as u8);
                body.extend_from_slice(name.as_bytes());
                // The control byte flags each present tag with its mask.
                let mut control = 0u8;
                for (tag, _) in tag_values {
                    control |= match tag {
                        1 => 1,
                        3 => 2,
                        4 => 4,
                        6 => 8,
                        _ => 0,
                    };
                }
                body.push(control);
                for (_, values) in tag_values {
                    for value in values {
                        write_vwi(&mut body, *value);
                    }
                }
            }
            record.extend_from_slice(&body);
            let idxt = record.len() as u32;
            record.extend_from_slice(&0u32.to_be_bytes());
            for offset in &offsets {
                record.extend_from_slice(&(*offset as u16).to_be_bytes());
            }
            record[20..24].copy_from_slice(&idxt.to_be_bytes());
            record[24..28].copy_from_slice(&(entries.len() as u32).to_be_bytes());
            records.push(record);
        }
        records
    }

    #[test]
    fn variable_width_integers_round_trip() {
        for value in [0u32, 1, 0x7f, 0x80, 0x3fff, 0x123456, u32::MAX] {
            let mut bytes = Vec::new();
            write_vwi(&mut bytes, value);
            let mut cursor = 0usize;
            assert_eq!(read_vwi(&bytes, &mut cursor), Some(value));
            assert_eq!(cursor, bytes.len());
        }
    }

    #[test]
    fn an_indx_chain_parses_entries_and_tags() {
        let records = indx_chain(vec![vec![
            ("00", vec![(1, vec![7]), (4, vec![9]), (6, vec![100, 50])]),
            ("01", vec![(1, vec![8]), (4, vec![10]), (6, vec![200, 3])]),
        ]]);

        let data = read_index(&records, 0).expect("index");
        assert_eq!(data.entries.len(), 2);
        assert_eq!(data.entries[0].tags[&1], [7]);
        assert_eq!(data.entries[0].tags[&6], [100, 50]);
        assert_eq!(data.entries[1].tags[&6], [200, 3]);
    }

    #[test]
    fn kf8_positions_map_fids_through_skeletons_and_fragments() {
        // Relative layout: the frag chain starts at record 1, the skeleton
        // chain at 3, the NCX chain at 5 (each is a header + one entry record).
        let mut records = vec![mobi_header(&[])];
        records.extend(indx_chain(vec![vec![("10", vec![(4, vec![7]), (6, vec![10, 20])])]]));
        records.extend(indx_chain(vec![vec![("SKEL", vec![(1, vec![1]), (6, vec![100, 50])])]]));
        records.extend(indx_chain(vec![vec![
            ("00", vec![(3, vec![0]), (6, vec![7, 5])]),
            ("01", vec![(3, vec![1]), (6, vec![7, 20])]),
        ]]));

        let header = &mut records[0];
        header.resize(256, 0);
        header[OFFSET_FRAG..OFFSET_FRAG + 4].copy_from_slice(&1u32.to_be_bytes());
        header[OFFSET_SKEL..OFFSET_SKEL + 4].copy_from_slice(&3u32.to_be_bytes());
        header[OFFSET_INDX..OFFSET_INDX + 4].copy_from_slice(&5u32.to_be_bytes());

        let section = Section::parse(&records, 0).expect("section");
        let (items, positions) = kf8_toc(&records, &section).expect("toc");

        // pos(fid 7) = skeleton end (100+50) + fragment offset 10 = 160.
        assert_eq!(positions[&7], 160);
        assert_eq!(items.iter().map(|item| item.offset).collect::<Vec<_>>(), [165, 180]);
    }

    #[test]
    fn a_broken_index_chain_falls_back_to_none() {
        let mut records = indx_chain(vec![vec![("SKEL", vec![(1, vec![1])])]]);
        records[0].clear(); // smash the header record
        assert!(read_index(&records, 0).is_none());
    }

    #[test]
    fn kindle_link_targets_resolve_to_offsets() {
        let mut positions = HashMap::new();
        positions.insert(3u32, 160usize);
        let resolver = PosResolver::Kf8(positions);
        assert_eq!(resolver.resolve("kindle:pos:fid:3:off:5"), Some(165));
        // fid and off are base 32.
        assert_eq!(resolver.resolve("kindle:pos:fid:3:off:K"), Some(160 + 20));
        assert_eq!(resolver.resolve("kindle:pos:fid:99:off:5"), None);
        assert_eq!(resolver.resolve("https://example.com"), None);

        let filepos = PosResolver::Filepos;
        assert_eq!(filepos.resolve("kindle:filepos:1234"), Some(1234));
        assert_eq!(filepos.resolve("kindle:pos:fid:3:off:5"), None);
    }

    #[test]
    fn mobi6_boundaries_come_from_the_guide_toc_page() {
        let mut raw = format!(
            "<html><body>{}<guide><reference type=\"toc\" filepos=\"40\"/>\
             <reference type=\"text\" filepos=\"999\"/></guide>ANCHORS",
            "x".repeat(28)
        );
        let anchors_at = raw.find("ANCHORS").expect("anchor slot");
        raw = raw.replace(
            "ANCHORS",
            &format!(
                "<a filepos=\"{a}\">第一章</a> 和 <a filepos=\"{b}\">第二章</a>",
                a = anchors_at,
                b = anchors_at + 30
            ),
        );

        let items = mobi6_toc(&raw).expect("toc");
        assert_eq!(
            items.iter().map(|item| item.offset).collect::<Vec<_>>(),
            [anchors_at, anchors_at + 30]
        );
        assert!(items.iter().all(|item| item.label.is_empty()));
    }

    #[test]
    fn a_guide_without_toc_yields_no_boundaries() {
        let raw = "<html><guide><reference type=\"text\" filepos=\"40\"/></guide></html>";
        assert!(mobi6_toc(raw).is_none());
    }

    #[test]
    fn filepos_attributes_become_internal_links() {
        assert_eq!(
            link_filepos("<a filepos=\"120\">甲</a><img recindex=\"3\" filepos=45>"),
            "<a href=\"kindle:filepos:120\">甲</a><img recindex=\"3\" href=\"kindle:filepos:45\">"
        );
        // A filepos without a number survives untouched.
        assert_eq!(link_filepos("<a filepos>"), "<a filepos>");
    }

    #[test]
    fn link_markers_resolve_to_chapter_indices() {
        let boundaries = [40usize, 90, 160];
        assert_eq!(chapter_index(&boundaries, 0), Some(0));
        assert_eq!(chapter_index(&boundaries, 40), Some(0));
        assert_eq!(chapter_index(&boundaries, 41), Some(0));
        assert_eq!(chapter_index(&boundaries, 90), Some(1));
        assert_eq!(chapter_index(&boundaries, 999), Some(2));

        let mut chapters = vec![RawChapter {
            title: None,
            paragraphs: vec!["\u{FFFB}kindle:filepos:100\u{1F}跳转".into(), "正文".into()],
        }];
        resolve_links(&mut chapters, &PosResolver::Filepos, &boundaries);
        assert_eq!(chapters[0].paragraphs[0], "\u{FFFB}1\u{1F}跳转");

        // An unresolvable target degrades to its text.
        let mut chapters = vec![RawChapter {
            title: None,
            paragraphs: vec!["\u{FFFB}kindle:pos:fid:8:off:1\u{1F}未知".into()],
        }];
        resolve_links(&mut chapters, &PosResolver::Filepos, &boundaries);
        assert_eq!(chapters[0].paragraphs[0], "未知");
    }

    #[test]
    fn embed_references_read_shared_pool_records() {
        let dir = fixture::temp_dir("mobi-asset");
        let path = dir.join("book.mobi");
        let mut header = mobi_header(&[]);
        header[OFFSET_FIRST_IMAGE..OFFSET_FIRST_IMAGE + 4].copy_from_slice(&1u32.to_be_bytes());
        std::fs::write(&path, build_pdb(&[&header, b"not an image", b"\xff\xd8\xff\xe0-jpeg"]))
            .expect("write");

        assert_eq!(
            read_asset(&path, "kindle:embed:0002?mime=image/jpeg").expect("asset"),
            b"\xff\xd8\xff\xe0-jpeg".to_vec()
        );
        assert!(read_asset(&path, "kindle:embed:0009").is_err());
        assert!(read_asset(&path, "garbage").is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_cover_counts_from_the_shared_pool() {
        let dir = fixture::temp_dir("mobi-cover");
        let path = dir.join("book.mobi");
        let mut header = mobi_header(&[
            (EXTH_TITLE, "书"),
            // Cover at offset 1 from the pool; the section's own pointer is a
            // red herring that must not win.
            (EXTH_COVER, "\u{1}"),
        ]);
        header[OFFSET_FIRST_IMAGE..OFFSET_FIRST_IMAGE + 4].copy_from_slice(&1u32.to_be_bytes());
        std::fs::write(&path, build_pdb(&[&header, b"\xff\xd8\xff\xe0-cover", b"filler"]))
            .expect("write");

        let metadata = read_metadata(&path).expect("metadata");
        let cover = metadata.cover.expect("封面必须被提取");
        assert_eq!(cover.bytes, b"\xff\xd8\xff\xe0-cover".to_vec());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[ignore = "real-book probe: cargo test -p colorreader --lib mobi -- --ignored --nocapture"]
    fn probe_real_book_wallpapers() {
        let dir = "/Users/xiaolong/Downloads";
        for name in ["金色梦乡 (伊坂幸太郎) (z-library.sk, 1lib.sk, z-lib.sk).mobi"] {
            let path = std::path::Path::new(dir).join(name);
            let chapters = read_chapters(&path).expect("chapters");
            for (idx, chapter) in chapters.iter().enumerate().take(24) {
                let wallpaper = chapter
                    .paragraphs
                    .iter()
                    .find(|p| p.starts_with(WALLPAPER_PARAGRAPH_PREFIX))
                    .map(|p| p[WALLPAPER_PARAGRAPH_PREFIX.len()..].to_string());
                let head: String = chapter
                    .paragraphs
                    .iter()
                    .filter(|p| !p.starts_with(WALLPAPER_PARAGRAPH_PREFIX))
                    .map(|p| p.chars().take(12).collect::<String>())
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" | ");
                println!(
                    "{idx:>3} title={:?} wallpaper={:?} head={head:?}",
                    chapter.title, wallpaper
                );
            }
        }
    }
}
