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
//!
//! The container, the decompressors and the index chains used to share one
//! 1300-line file. They are separate modules now: [`pdb`] reads the records and
//! the section header, [`palmdoc`] expands the two compressions Amazon ships,
//! [`exth`] reads the metadata block, [`index`] walks the KF8 and MOBI6 tables
//! of contents, [`markup`] rewrites the Kindle-only attributes into what the
//! shared HTML parser understands, and [`text`] and [`bytes`] hold the decoding
//! and the byte readers every one of them uses. What stays here is the format's
//! constants, the three public entry points and the test fixture.

use std::collections::HashMap;
use std::path::Path;

use super::html::{self, chapter_from_blocks, chapters_from_blocks};
use super::{BookMetadata, LINK_FIELD_SEPARATOR, LINK_PARAGRAPH_PREFIX, RawChapter};
use crate::error::{AppError, AppResult};

use self::index::{PosResolver, kf8_toc, mobi6_toc};
use self::markup::{
    flow_backgrounds, link_filepos, resolve_links, rewrite_recindex, split_oversized,
};
use self::pdb::{Section, read_records, resource_base};
use self::text::decode_text;

mod bytes;
mod exth;
mod index;
mod markup;
mod palmdoc;
mod pdb;
mod text;

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

/// Synthetic MOBI bytes for tests outside this module.
///
/// `library::import` needs a file the real pipeline can actually parse, and the
/// byte layout is spelled down exactly once — here, next to the parser that
/// reads it — rather than re-derived in the test that wants one.
#[cfg(test)]
pub(crate) mod synth {
    use super::exth::{EXTH_AUTHOR, EXTH_TITLE};
    use super::*;

    /// Builds a Palm database with the given records and no valid book inside.
    pub fn build_pdb(records: &[&[u8]]) -> Vec<u8> {
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

    /// Record 0 of an uncompressed, unencrypted MOBI with an EXTH block:
    /// PalmDOC header, MOBI header, then the metadata records.
    pub fn mobi_header(exth: &[(u32, &str)]) -> Vec<u8> {
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

    /// A whole one-chapter book: metadata record plus the HTML text record.
    pub fn book_bytes(title: &str, author: &str, html: &str) -> Vec<u8> {
        build_pdb(&[&mobi_header(&[(EXTH_TITLE, title), (EXTH_AUTHOR, author)]), html.as_bytes()])
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::exth::{EXTH_AUTHOR, EXTH_COVER, EXTH_LANGUAGE, EXTH_TITLE};
    use super::index::{chapter_index, read_index, read_vwi};
    use super::palmdoc::{palmdoc_decompress, trailing_len};
    use super::synth::{build_pdb, mobi_header};
    use super::text::sniff_image;
    use super::*;
    use crate::document::{WALLPAPER_PARAGRAPH_PREFIX, fixture};

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
    #[ignore = "real-book probe: cargo test -p fangce --lib mobi -- --ignored --nocapture"]
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
