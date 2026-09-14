//! Notes export: one book's highlights and notes as a file the reader keeps
//! after the app is gone.
//!
//! Two shapes, picked by the destination extension. Markdown reads like a page
//! — the quoted passage, then the note under it, grouped by chapter. CSV is one
//! row per highlight, for a spreadsheet. Both are plain UTF-8 text: no archive,
//! no schema, nothing that needs this app to open again. A book pack (see
//! `pack`) is the other half of the story and answers a different question —
//! that one is for restoring the *reading state*, this one is for reading it.
//!
//! Chapters are headings by *number*, never by title looked up in `chapters`:
//! foliate books number their annotations by section, and a title fetched by
//! that index would be off by exactly the offset those two lists differ by.
//! The number is also what the reader's own annotation list shows, so the file
//! and the app agree on where a highlight lives.
//!
//! Every highlight also carries a `colorreader://` link back to itself. The
//! link names the book and the annotation and *nothing else* — no position, no
//! chapter, no offset. Positions are the one thing this app cannot state
//! portably: a foliate highlight is anchored by CFI, a paragraph one by
//! character offset, a PDF one by page, and the three do not convert into each
//! other. The row the id points at already knows which of the three it is, so
//! the link stays true across all of them, and a reader who opens it lands on
//! the passage in whichever renderer that book uses.

use std::path::Path;

use crate::db::Library;
use crate::error::{AppError, AppResult};

use super::{annotations, has_extension, repository};

/// Extensions that select Markdown.
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];
/// Extension that selects CSV.
const CSV_EXT: &str = "csv";

/// A byte-order mark, so Excel opens the file as UTF-8 instead of guessing the
/// system code page — the difference between 三体 and mojibake.
const CSV_BOM: &str = "\u{feff}";

/// Scheme the app registers for deep links (see `deep_link`), so a highlight in
/// an exported file can be reopened in the app that wrote it.
pub const SCHEME: &str = "colorreader";

/// One highlight as the export prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    /// The row's own id; what the link back into the app points at.
    id: String,
    chapter_idx: usize,
    text: String,
    note: Option<String>,
    color: Option<String>,
    style: Option<String>,
}

/// Everything both renderers read, gathered in one pass so a book is still
/// exported from a single consistent snapshot.
#[derive(Debug)]
struct Notes {
    id: String,
    title: String,
    authors: Vec<String>,
    /// 0..1, straight from the shelf.
    progress: f64,
    entries: Vec<Entry>,
}

/// The link a highlight carries back into the app.
///
/// Both ids are v4 UUIDs, so nothing needs escaping; the shape is pinned by
/// `src/lib/deeplink.ts`, which parses the other end of it.
fn link(book_id: &str, annotation_id: &str) -> String {
    format!("{SCHEME}://book/{book_id}?annotation={annotation_id}")
}

/// Writes one book's highlights and notes to `dest`.
///
/// The format follows the extension: `.md` (or `.markdown`) for prose, `.csv`
/// for a table. Anything else is refused rather than guessed at, because
/// writing the wrong shape into a file the reader chose is worse than saying no.
pub fn export(library: &Library, book_id: &str, dest: &Path) -> AppResult<()> {
    let notes = gather(library, book_id)?;
    let rendered = if has_extension(dest, &MARKDOWN_EXTENSIONS) {
        markdown(&notes)
    } else if has_extension(dest, &[CSV_EXT]) {
        csv(&notes)
    } else {
        return Err(AppError::InvalidArgument("导出格式请用 .md 或 .csv".into()));
    };
    std::fs::write(dest, rendered)?;
    Ok(())
}

fn gather(library: &Library, book_id: &str) -> AppResult<Notes> {
    let book = library
        .with(|conn| repository::get(conn, book_id))?
        .ok_or_else(|| AppError::NotFound(book_id.to_string()))?;
    let entries = library.with(|conn| {
        Ok(annotations::list(conn, book_id)?
            .into_iter()
            .map(|annotation| Entry {
                id: annotation.id,
                chapter_idx: annotation.chapter_idx,
                text: annotation.text,
                note: annotation.note,
                color: annotation.color,
                style: annotation.style,
            })
            .collect::<Vec<_>>())
    })?;

    Ok(Notes {
        id: book_id.to_string(),
        title: book.title,
        authors: book.authors,
        progress: book.progress,
        entries,
    })
}

/// The whole file as one page of Markdown.
fn markdown(notes: &Notes) -> String {
    let mut blocks = vec![format!("# 《{}》标注与笔记", notes.title), summary(notes)];

    if notes.entries.is_empty() {
        blocks.push("这本书还没有标注。".to_string());
    }

    // One heading per chapter, emitted when the chapter actually changes: the
    // list is already in reading order, so a group never needs to be buffered.
    let mut chapter: Option<usize> = None;
    for entry in &notes.entries {
        if chapter != Some(entry.chapter_idx) {
            chapter = Some(entry.chapter_idx);
            blocks.push(format!("## 第 {} 章", entry.chapter_idx + 1));
        }
        blocks.push(quote(&entry.text));
        if let Some(note) = entry.note.as_deref() {
            blocks.push(note.to_string());
        }
        // The way back in. A link rather than a bare URL: note apps render the
        // one and leave the other as text that has to be copied out by hand.
        blocks.push(format!("[在 ColorReader 中打开]({})", link(&notes.id, &entry.id)));
    }

    // Trailing newline: the file is meant to be opened by other tools, and a
    // text file that ends without one makes every one of them complain.
    format!("{}\n", blocks.join("\n\n"))
}

/// The line under the title: who wrote it, how much there is, how far in.
fn summary(notes: &Notes) -> String {
    let noted = notes.entries.iter().filter(|entry| entry.note.is_some()).count();
    let mut parts = vec![format!("{} 条标注", notes.entries.len())];
    if noted > 0 {
        parts.push(format!("{noted} 条有笔记"));
    }
    if notes.progress > 0.0 {
        parts.push(format!("阅读进度 {}%", (notes.progress * 100.0).round() as i64));
    }

    let summary = parts.join(" · ");
    match notes.authors.is_empty() {
        true => summary,
        false => format!("{} · {summary}", notes.authors.join("、")),
    }
}

/// One blockquote. Every line gets its own `>`, so a highlight spanning
/// paragraphs stays a single quote instead of making its second half a nested
/// one.
fn quote(text: &str) -> String {
    text.lines().map(|line| format!("> {line}")).collect::<Vec<_>>().join("\n")
}

/// The whole file as one CSV table.
fn csv(notes: &Notes) -> String {
    let mut out = String::from(CSV_BOM);
    out.push_str("章节,原文,笔记,颜色,样式,链接\n");
    for entry in &notes.entries {
        out.push_str(&format!(
            "{},{},{},{},{},{}\n",
            entry.chapter_idx + 1,
            csv_field(&entry.text),
            csv_field(entry.note.as_deref().unwrap_or("")),
            // Left empty rather than filled with the defaults the UI applies:
            // "never chosen" and "chose yellow" are different facts, and the
            // file should not invent one of them.
            csv_field(entry.color.as_deref().unwrap_or("")),
            csv_field(entry.style.as_deref().unwrap_or("")),
            // Raw rather than as a `[text](url)` pair: a spreadsheet column is
            // a value, and the URL is what the app answers to.
            csv_field(&link(&notes.id, &entry.id)),
        ));
    }
    out
}

/// Quotes a field when it holds a delimiter, a quote or a line break — the
/// three things that would otherwise split one row into several.
fn csv_field(value: &str) -> String {
    match value.contains([',', '"', '\n', '\r']) {
        true => format!("\"{}\"", value.replace('"', "\"\"")),
        false => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;
    use crate::library::import::ImportOutcome;
    use crate::library::repository::{BookQuery, BookSummary};
    use std::path::PathBuf;

    struct Harness {
        dir: PathBuf,
        layout: Layout,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&dir).expect("open library");
            Self { dir, layout, library }
        }

        fn import(&self, paths: &[PathBuf]) -> Vec<ImportOutcome> {
            super::super::import::import_files(
                &self.library,
                &self.layout,
                paths,
                None,
                &mut |_, _, _| {},
            )
        }

        fn shelf(&self) -> Vec<BookSummary> {
            self.library.with(|conn| repository::list(conn, &BookQuery::default())).expect("list")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// A book with two highlights in chapter 0 (one carrying a note) and one in
    /// chapter 2, in a deliberately shuffled amount of ink.
    fn seed_book(harness: &Harness) -> String {
        let epub = fixture::write_epub(
            &harness.dir,
            "source.epub",
            &fixture::full_opf("三体", "刘慈欣"),
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );
        harness.import(&[epub]);
        let id = harness.shelf()[0].id.clone();

        harness
            .library
            .with(|conn| {
                repository::set_progress(conn, &id, 0.256, None)?;
                let first =
                    annotations::create(conn, &id, 0, 1, 3, "你好", None, Some("#ffd12e"), None)?;
                annotations::set_note(conn, &first.id, Some("第三章的伏笔"))?;
                annotations::create(conn, &id, 0, 5, 9, "再见", None, None, Some("squiggly"))?;
                annotations::create(conn, &id, 2, 1, 4, "最后一段", None, None, None)?;
                Ok(())
            })
            .expect("seed annotations");
        id
    }

    fn write(harness: &Harness, id: &str, name: &str) -> String {
        let dest = harness.dir.join(name);
        export(&harness.library, id, &dest).expect("export");
        std::fs::read_to_string(dest).expect("read back")
    }

    fn notes(entries: Vec<Entry>) -> Notes {
        Notes {
            id: BOOK.into(),
            title: "三体".into(),
            authors: vec!["刘慈欣".into()],
            progress: 0.5,
            entries,
        }
    }

    /// A short book id, so the expected file stays readable. The format itself
    /// is pinned by `the_link_format_is_the_one_the_frontend_parses`, and the
    /// ids a real book hands out are exercised end to end below.
    const BOOK: &str = "b1";

    fn entry(id: &str, chapter_idx: usize, text: &str, note: Option<&str>) -> Entry {
        Entry {
            id: id.into(),
            chapter_idx,
            text: text.into(),
            note: note.map(str::to_string),
            color: None,
            style: None,
        }
    }

    /// The annotation ids the app has for a book, in list order.
    fn annotation_ids(harness: &Harness, book_id: &str) -> Vec<String> {
        harness
            .library
            .with(|conn| annotations::list(conn, book_id))
            .expect("list annotations")
            .into_iter()
            .map(|annotation| annotation.id)
            .collect()
    }

    #[test]
    fn markdown_groups_by_chapter_and_puts_notes_under_their_quote() {
        let rendered = markdown(&notes(vec![
            entry("a1", 0, "你好", Some("第三章的伏笔")),
            entry("a2", 0, "再见", None),
            entry("a3", 2, "最后一段", Some("记一笔")),
        ]));

        assert_eq!(
            rendered,
            "# 《三体》标注与笔记\n\
             \n\
             刘慈欣 · 3 条标注 · 2 条有笔记 · 阅读进度 50%\n\
             \n\
             ## 第 1 章\n\
             \n\
             > 你好\n\
             \n\
             第三章的伏笔\n\
             \n\
             [在 ColorReader 中打开](colorreader://book/b1?annotation=a1)\n\
             \n\
             > 再见\n\
             \n\
             [在 ColorReader 中打开](colorreader://book/b1?annotation=a2)\n\
             \n\
             ## 第 3 章\n\
             \n\
             > 最后一段\n\
             \n\
             记一笔\n\
             \n\
             [在 ColorReader 中打开](colorreader://book/b1?annotation=a3)\n"
        );
    }

    #[test]
    fn the_link_format_is_the_one_the_frontend_parses() {
        // The other end of this contract is `parseDeepLink` in
        // `src/lib/deeplink.ts`; the two are pinned to the same string.
        assert_eq!(link("book-1", "note-1"), "colorreader://book/book-1?annotation=note-1");
    }

    #[test]
    fn markdown_keeps_a_multiline_quote_a_single_block() {
        let rendered = markdown(&notes(vec![entry("a1", 0, "第一行\n第二行", None)]));
        assert!(rendered.contains("> 第一行\n> 第二行"), "{rendered}");
    }

    #[test]
    fn markdown_says_so_when_there_is_nothing_to_export() {
        let rendered = markdown(&notes(vec![]));
        assert!(rendered.contains("这本书还没有标注。"), "{rendered}");
        assert!(rendered.contains("0 条标注"), "{rendered}");
    }

    #[test]
    fn a_book_without_an_author_keeps_the_summary_line_clean() {
        let mut notes = notes(vec![entry("a1", 0, "你好", None)]);
        notes.authors.clear();
        let rendered = markdown(&notes);
        assert!(rendered.contains("\n1 条标注 · 阅读进度 50%\n"), "{rendered}");
    }

    #[test]
    fn csv_is_one_row_per_highlight_with_a_bom() {
        let rendered = csv(&notes(vec![entry("a1", 0, "你好", Some("伏笔"))]));
        assert_eq!(
            rendered,
            "\u{feff}章节,原文,笔记,颜色,样式,链接\n1,你好,伏笔,,,colorreader://book/b1?annotation=a1\n",
            "旧标注没写过颜色和样式，文件不该替它们编一个"
        );
    }

    #[test]
    fn a_csv_field_escapes_its_delimiters() {
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("two\nlines"), "\"two\nlines\"");
        assert_eq!(csv_field("plain"), "plain");
    }

    #[test]
    fn exporting_a_real_book_writes_its_highlights_and_notes() {
        let harness = Harness::new("export-markdown");
        let id = seed_book(&harness);
        let ids = annotation_ids(&harness, &id);

        let rendered = write(&harness, &id, "notes.md");
        assert!(rendered.starts_with("# 《三体》标注与笔记\n"), "{rendered}");
        assert!(rendered.contains("刘慈欣 · 3 条标注 · 1 条有笔记 · 阅读进度 26%"), "{rendered}");
        assert!(rendered.contains("## 第 1 章"), "{rendered}");
        assert!(rendered.contains("## 第 3 章"), "{rendered}");
        assert!(rendered.contains("> 你好\n\n第三章的伏笔"), "{rendered}");
        // Real ids are v4 UUIDs, and every highlight gets its own link.
        assert_eq!(ids.len(), 3);
        for annotation_id in &ids {
            let back = format!(
                "[在 ColorReader 中打开](colorreader://book/{id}?annotation={annotation_id})"
            );
            assert!(rendered.contains(&back), "缺链接 {back}\n{rendered}");
        }
    }

    #[test]
    fn exporting_a_book_as_csv_writes_one_row_per_highlight() {
        let harness = Harness::new("export-csv");
        let id = seed_book(&harness);
        let ids = annotation_ids(&harness, &id);

        let rendered = write(&harness, &id, "notes.csv");
        let rows: Vec<&str> = rendered.lines().collect();
        assert_eq!(rows.len(), 4, "表头加三条标注：{rendered}");
        assert_eq!(rows[0], "\u{feff}章节,原文,笔记,颜色,样式,链接");
        assert_eq!(rows[1], format!("1,你好,第三章的伏笔,#ffd12e,,{}", link(&id, &ids[0])));
        assert_eq!(rows[2], format!("1,再见,,,squiggly,{}", link(&id, &ids[1])));
        assert_eq!(rows[3], format!("3,最后一段,,,,{}", link(&id, &ids[2])));
    }

    #[test]
    fn an_unknown_extension_is_refused_rather_than_guessed() {
        let harness = Harness::new("export-unknown-ext");
        let id = seed_book(&harness);
        let err = export(&harness.library, &id, &harness.dir.join("notes.pdf"));
        assert!(matches!(err, Err(AppError::InvalidArgument(_))), "不认识的扩展名要拒绝");
    }

    #[test]
    fn exporting_a_book_that_is_not_on_the_shelf_is_not_found() {
        let harness = Harness::new("export-missing-book");
        let err = export(&harness.library, "nope", &harness.dir.join("notes.md"));
        assert!(matches!(err, Err(AppError::NotFound(_))));
    }

    #[test]
    fn the_extension_match_is_case_insensitive() {
        let harness = Harness::new("export-case");
        let id = seed_book(&harness);
        assert!(write(&harness, &id, "notes.MD").starts_with("# 《三体》"));
        assert!(write(&harness, &id, "notes.CSV").starts_with("\u{feff}章节"));
    }
}
