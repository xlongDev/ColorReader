//! Writing recognised page text back into the chapter corpus.
//!
//! The corpus is the one thing every downstream feature already speaks: search
//! (`chapters_fts` is maintained by trigger on this table), read-aloud, RAG
//! chunking and the reading assistant all read `chapters`. A recognised page
//! joins them by being an ordinary row, not by a second path through the
//! reader — which is why this module is one `UPDATE` and nothing else.

use rusqlite::params;
use serde::Serialize;

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::chapters;

/// Which pages of a book still have no text to read.
///
/// The answer comes from the corpus, not from the renderer: a page is a scan
/// when its stored chapter holds no characters. That is the same `chars` search,
/// read-aloud and the assistant already read, so a page dropping off this list
/// is a page those four have gained — no second notion of "has text" to keep in
/// step with the first.
///
/// 🔴 **It pays the text debt first, and that is not a formality.** A freshly
/// imported PDF stores its page index with every `chars` at 0, so reading the
/// column alone would call the whole book a scan and quote the reader a
/// 756-page bill for a book whose text was merely still deferred. The debt is
/// one decode of the document — the same one the importer starts on a background
/// thread and the reader triggers on its first chapter — so in the ordinary case
/// this is a flag read, not a decode.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrScan {
    /// Every page the book has, so the reader can be told "210 of 756".
    pub total: usize,
    /// 0-based chapter indices — for a PDF, its page numbers.
    pub pages: Vec<usize>,
}

/// The pages of `book_id` that still need recognising, in reading order.
pub fn scanned_pages(library: &Library, book_id: &str) -> AppResult<OcrScan> {
    let chapters = chapters::ensure_text(library, book_id)?;
    let pages =
        chapters.iter().filter(|chapter| chapter.chars == 0).map(|chapter| chapter.idx).collect();
    Ok(OcrScan { total: chapters.len(), pages })
}

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

    /// The list a whole-book run is driven by: the pages with no text, and a
    /// total to quote alongside them.
    #[test]
    fn the_scan_list_names_the_empty_pages_and_counts_the_whole_book() {
        let (dir, library) = library("ocr-scan");
        seed(&library, "book-5", &["", "这一页有文字", "", ""]);

        let scan = scanned_pages(&library, "book-5").expect("scan");
        assert_eq!(scan.total, 4);
        assert_eq!(scan.pages, vec![0, 2, 3], "有文字的那页不该在列表里");

        // The list is derived, not remembered: recognising a page takes it off
        // the next answer. That is what makes a stopped run resumable — pressing
        // the button again picks up exactly what is left, with no bookkeeping.
        write_page(&library, "book-5", 2, "认出来的字").expect("write");
        let after = scanned_pages(&library, "book-5").expect("scan again");
        assert_eq!(after.total, 4);
        assert_eq!(after.pages, vec![0, 3]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 🔴 A book whose text was never extracted must not read as one giant scan.
    ///
    /// The stored rows here are two empty pages, so an implementation that
    /// trusted the `chars` column would answer "both pages are scans" and quote
    /// the reader a bill for the whole book. The book is marked pending and its
    /// source holds three chapters of real text, so the only answer that proves
    /// the debt was paid is the source's own: three pages, none of them scans.
    #[test]
    fn a_deferred_book_is_extracted_before_its_pages_are_called_scans() {
        let (dir, library) = library("ocr-deferred");
        let source = dir.join("book.txt");
        std::fs::write(
            &source,
            "第一章 开始\n\n正文甲\n\n第二章 继续\n\n正文乙\n\n第三章 尾声\n\n正文丙\n",
        )
        .expect("write source");
        // Seed first — the rows have to exist before the row can be pointed at
        // the source. The seeded pages are the *index* the deferral left behind
        // (two empty pages); the flag says the text behind them was never
        // extracted.
        seed(&library, "b7", &["", ""]);
        library
            .with(|conn| {
                conn.execute(
                    "UPDATE books SET format = 'txt', file_path = ?1, chapters_pending = 1 \
                     WHERE id = 'b7'",
                    params![source.to_string_lossy()],
                )?;
                Ok(())
            })
            .expect("point at the source and mark it pending");

        let scan = scanned_pages(&library, "b7").expect("scan");
        assert_eq!(scan.total, 3, "总数要来自源文件，不是延期时留下的索引");
        assert_eq!(scan.pages, Vec::<usize>::new(), "源文件里的三页都有文字");
        std::fs::remove_dir_all(&dir).ok();
    }
}
