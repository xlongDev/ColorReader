//! Writing recognised page text back into the chapter corpus.
//!
//! The corpus is the one thing every downstream feature already speaks: search
//! (`chapters_fts` is maintained by trigger on this table), read-aloud, RAG
//! chunking and the reading assistant all read `chapters`. A recognised page
//! joins them by being an ordinary row, not by a second path through the
//! reader — which is why this module is one `UPDATE` and nothing else.

use rusqlite::params;

use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Checks a page is one worth recognising, before a megabyte is uploaded to
/// find out.
///
/// Two refusals, and neither is a formality: a page the book does not have is
/// a wrong page number, and a page that already has text is one pdf.js read
/// perfectly well — overwriting a real extraction because a button was pressed
/// is worse than leaving the page alone.
pub fn prepare_page(library: &Library, book_id: &str, page: usize) -> AppResult<()> {
    let existing: Option<usize> = library.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT chars FROM chapters WHERE book_id = ?1 AND idx = ?2",
                params![book_id, page as i64],
                |row| row.get::<_, i64>(0).map(|chars| chars as usize),
            )
            .ok())
    })?;
    match existing {
        None => Err(AppError::NotFound(format!("这本书没有第 {} 页的章节", page + 1))),
        Some(chars) if chars > 0 => {
            Err(AppError::InvalidArgument("这一页已经有文字了，不需要识别".into()))
        }
        Some(_) => Ok(()),
    }
}

/// Stores `text` as the body of chapter `page` (0-based, as the corpus
/// indexes it) and returns how many characters it holds.
pub fn write_page(library: &Library, book_id: &str, page: usize, text: &str) -> AppResult<usize> {
    let body = normalise(text);
    if body.is_empty() {
        return Err(AppError::InvalidArgument("这一页没有识别出文字".into()));
    }
    let chars = body.chars().count();
    library.with(|conn| {
        let changed = conn.execute(
            "UPDATE chapters SET content = ?3, chars = ?4 WHERE book_id = ?1 AND idx = ?2",
            params![book_id, page as i64, body, chars as i64],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("这本书没有第 {} 页的章节", page + 1)));
        }
        Ok(())
    })?;
    Ok(chars)
}

/// The shape `chapters` stores: one paragraph per line, no blank lines.
///
/// Models are generous with whitespace — blank lines between every paragraph,
/// trailing spaces — and the corpus splits on newlines, so an un-normalised
/// answer becomes a chapter full of empty paragraphs that the reader renders
/// as gaps.
fn normalise(raw: &str) -> String {
    raw.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;
    use crate::library::chapters;

    fn library(tag: &str) -> (std::path::PathBuf, Library) {
        let dir = fixture::temp_dir(tag);
        let layout = Layout::create(dir.clone()).expect("layout");
        let library = Library::open(&layout.data_dir).expect("open");
        (dir, library)
    }

    /// One chapter per page, the shape a PDF's page index produces. An empty
    /// string is a page with no text layer — the whole reason this module
    /// exists.
    fn seed(library: &Library, book_id: &str, pages: &[&str]) {
        library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                     file_size, added_at, updated_at) \
                     VALUES (?1, '扫描件', 'x', 'pdf', ?1, 'p', 1, 1, 1)",
                    rusqlite::params![book_id],
                )?;
                Ok(())
            })
            .expect("insert book");
        let chapters: Vec<crate::document::RawChapter> = pages
            .iter()
            .enumerate()
            .map(|(page, text)| crate::document::RawChapter {
                title: Some(format!("第 {} 页", page + 1)),
                paragraphs: if text.is_empty() { Vec::new() } else { vec![(*text).into()] },
            })
            .collect();
        library.with_tx(|tx| chapters::insert(tx, book_id, &chapters)).expect("seed chapters");
    }

    fn paragraphs(library: &Library, book_id: &str, page: usize) -> Vec<String> {
        library
            .with(|conn| chapters::content(conn, book_id, page))
            .expect("read")
            .map(|content| content.paragraphs)
            .unwrap_or_default()
    }

    #[test]
    fn a_recognised_page_joins_the_corpus_the_search_index_reads() {
        let (dir, library) = library("ocr-write");
        let book_id = "book-1";
        seed(&library, book_id, &["", "", ""]);

        let chars =
            write_page(&library, book_id, 1, "第一段。\n\n\n  第二段。  \n").expect("write");
        assert_eq!(chars, "第一段。\n第二段。".chars().count());

        // Read back the way the reader does: empty lines must not become empty
        // paragraphs, because they render as gaps between the sentences.
        assert_eq!(paragraphs(&library, book_id, 1), vec!["第一段。", "第二段。"]);

        // The FTS trigger fired on its own — a search finds this page without
        // anything re-indexing it by hand.
        let hits = library
            .with(|conn| crate::library::search::query(conn, "第二段", None, 10))
            .expect("search");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].book_id, book_id);

        // And the pages either side are untouched.
        assert_eq!(paragraphs(&library, book_id, 0).concat(), "");
        assert_eq!(paragraphs(&library, book_id, 2).concat(), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_page_that_already_has_text_is_refused_before_anything_is_uploaded() {
        let (dir, library) = library("ocr-existing");
        let book_id = "book-2";
        seed(&library, book_id, &["已经抽出来的正文"]);

        let err = prepare_page(&library, book_id, 0).expect_err("refuse");
        assert!(err.to_string().contains("已经有文字"), "{err}");
        assert_eq!(paragraphs(&library, book_id, 0), vec!["已经抽出来的正文"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_page_the_book_does_not_have_is_named_by_its_number() {
        let (dir, library) = library("ocr-missing");
        seed(&library, "book-3", &["", ""]);
        let err = prepare_page(&library, "book-3", 99).expect_err("missing");
        assert!(err.to_string().contains("第 100 页"), "{err}");
        assert!(prepare_page(&library, "book-3", 1).is_ok(), "空页是可以识别的");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_answer_with_nothing_in_it_is_refused() {
        let (dir, library) = library("ocr-blank");
        seed(&library, "book-4", &[""]);
        assert!(write_page(&library, "book-4", 0, "  \n\n ").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
