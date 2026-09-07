//! PDF: one chapter per page, extracted as text.
//!
//! A PDF is fixed layout, so fidelity is not on offer: what the library stores
//! is the text of each page, which is what full-text search, the reader, the
//! voice and the assistant all consume. Layout, fonts and illustrations are
//! lost — say so rather than pretending otherwise.

use std::path::Path;

use super::{BookMetadata, RawChapter};

use crate::document::plain;
use crate::error::{AppError, AppResult};

pub fn read_metadata(path: &Path) -> AppResult<BookMetadata> {
    let mut metadata = BookMetadata::default();
    if let Ok(bytes) = std::fs::read(path) {
        metadata.title = info_field(&bytes, b"Title").unwrap_or_default();
        if let Some(author) = info_field(&bytes, b"Author") {
            metadata.authors = vec![author];
        }
    }
    // Most PDFs carry no usable Info dictionary; the file name is the honest
    // fallback and `read_metadata` applies it when the title is still empty.
    if metadata.title.trim().is_empty() {
        metadata.title = plain::title_from_stem(path);
    }
    Ok(metadata)
}

/// Turns every page into a chapter, keeping page numbers honest.
///
/// Blank pages are kept: dropping them would make the reader's page N differ
/// from the document's page N, which is the one thing a PDF reader must not do.
pub fn read_chapters(path: &Path) -> AppResult<Vec<RawChapter>> {
    let bytes = std::fs::read(path)?;
    let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)
        .map_err(|err| AppError::Parse(format!("PDF 解析失败：{err}")))?;

    if pages.iter().all(|page| page.trim().is_empty()) {
        return Err(AppError::Parse("这份 PDF 没有可提取的文字，可能是扫描件".into()));
    }

    Ok(pages
        .into_iter()
        .enumerate()
        .map(|(index, page)| RawChapter {
            title: Some(format!("第 {} 页", index + 1)),
            paragraphs: paragraphs_of(&page),
        })
        .collect())
}

/// Splits a page's text into paragraphs: pdf-extract emits one line per text
/// run, and blank lines separate them.
fn paragraphs_of(page: &str) -> Vec<String> {
    page.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

/// Reads a field out of the PDF Info dictionary, when there is one.
fn info_field(bytes: &[u8], key: &[u8]) -> Option<String> {
    let document = pdf_extract::Document::load_mem(bytes).ok()?;
    // `/Info` is almost always an indirect reference, which has to be followed
    // to reach the dictionary itself.
    let object = document.trailer.get(b"Info").ok()?;
    let info = match object.as_dict() {
        Ok(dictionary) => dictionary,
        Err(_) => document.get_object(object.as_reference().ok()?).ok()?.as_dict().ok()?,
    };
    let value = info.get(key).ok()?;
    let text = pdf_extract::decode_text_string(value).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_lines_become_paragraph_breaks() {
        assert_eq!(
            paragraphs_of("第一段\n\n  第二段  \n\n\n第三段\n"),
            ["第一段", "第二段", "第三段"]
        );
    }

    #[test]
    fn a_page_of_only_whitespace_has_no_paragraphs() {
        assert!(paragraphs_of("\n\n   \n").is_empty());
    }

    #[test]
    fn every_page_becomes_a_numbered_chapter() {
        // Latin text only: a hand-written string literal has no ToUnicode map,
        // so anything outside the font's single-byte encoding comes back as
        // noise. Real CJK PDFs ship that map and extract correctly.
        let dir = crate::document::fixture::temp_dir("pdf-pages");
        let path = crate::document::fixture::write_pdf(
            &dir,
            "book.pdf",
            &["Text of page one", "Text of page two"],
            Some("PDF Title"),
        );

        let chapters = read_chapters(&path).expect("chapters");
        assert_eq!(chapters.len(), 2, "{chapters:?}");
        assert_eq!(chapters[0].title.as_deref(), Some("第 1 页"));
        assert!(
            chapters[0].paragraphs.iter().any(|p| p.contains("page one")),
            "{:?}",
            chapters[0].paragraphs
        );
        assert!(
            chapters[1].paragraphs.iter().any(|p| p.contains("page two")),
            "{:?}",
            chapters[1].paragraphs
        );

        let metadata = read_metadata(&path).expect("metadata");
        assert_eq!(metadata.title, "PDF Title");
        assert_eq!(metadata.authors, ["fixture"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_pdf_without_an_info_dictionary_falls_back_to_the_file_name() {
        let dir = crate::document::fixture::temp_dir("pdf-noinfo");
        let path = crate::document::fixture::write_pdf(&dir, "报告.pdf", &["正文"], None);

        assert_eq!(read_metadata(&path).expect("metadata").title, "报告");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_that_is_not_a_pdf_fails_with_a_parse_error() {
        let dir = crate::document::fixture::temp_dir("pdf-bad");
        let path = dir.join("book.pdf");
        std::fs::write(&path, b"definitely not a pdf").expect("write");

        let err = read_chapters(&path).expect_err("必须报错");
        assert!(err.to_string().starts_with("parse error:"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
