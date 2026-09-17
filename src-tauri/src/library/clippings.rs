//! Kindle `My Clippings.txt` import.
//!
//! The clippings file knows a highlight's *text* and a `位置 #1234-1237` line
//! number, and nothing else. The line number counts positions inside the file
//! Amazon shipped, which is not the file we have: a re-imported AZW3, an EPUB
//! from elsewhere, a re-flowed TXT all number their positions differently. So
//! the text is the only anchor that survives, and that is what this module
//! matches on — every clipping is located by finding its text in the chapter
//! bodies we already store for full-text search.
//!
//! Matching ignores whitespace and the invisible characters the two sides
//! disagree about (Kindle drops the line breaks an EPUB splits a paragraph at;
//! extracted book text keeps soft hyphens the clipping does not have).
//! Everything else has to be identical, which it is: both sides are the same
//! sentence.
//!
//! For EPUB/MOBI/AZW3 the located offsets are not enough on their own — those
//! books are painted by foliate, which anchors on a CFI. [`Annotation.cfi`]
//! stays `None` here and the reader resolves it the first time it loads the
//! section (see `FoliateBookView`); the offsets are what the annotation list
//! orders by until then.
//!
//! [`Annotation.cfi`]: crate::library::annotations::Annotation::cfi

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::AppResult;
use crate::library::annotations;

/// The separator Kindle writes between entries.
const SEPARATOR: char = '=';

/// Shortest run of `=` that counts as a separator. Kindle writes ten; being
/// lenient here costs nothing and survives files other tools rewrote.
const SEPARATOR_RUN: usize = 8;

/// Distinct unknown titles the report carries back. A clippings file from a
/// decade of reading can name hundreds of books the shelf never got; the head
/// of that list is the actionable part.
const MAX_UNKNOWN_TITLES: usize = 12;

/// One highlight lifted out of a clippings file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clipping {
    pub title: String,
    pub author: String,
    pub text: String,
}

/// Everything a clippings file turned into.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub highlights: Vec<Clipping>,
    /// Notes and bookmarks share the file with highlights. They are counted so
    /// the report can say where the entries the reader expected went.
    pub notes: usize,
    pub bookmarks: usize,
}

/// Which of the three things Kindle records an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Highlight,
    Note,
    Bookmark,
    Unknown,
}

/// Reads a clippings file. Never fails: a malformed entry is skipped, because
/// the file is written by a device the reader cannot fix.
pub fn parse(source: &str) -> Parsed {
    // Kindle writes a BOM, and line endings depend on the device and on
    // whichever machine the file was copied through.
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let normalised = source.replace("\r\n", "\n").replace('\r', "\n");

    let mut parsed = Parsed::default();
    let mut entry: Vec<&str> = Vec::new();
    for line in normalised.lines() {
        if is_separator(line) {
            read_entry(&entry, &mut parsed);
            entry.clear();
            continue;
        }
        entry.push(line);
    }
    read_entry(&entry, &mut parsed);
    parsed
}

fn is_separator(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.chars().count() < SEPARATOR_RUN {
        return false;
    }
    trimmed.chars().all(|ch| ch == SEPARATOR)
}

/// Reads one entry into `parsed`, ignoring it when it is a note/bookmark or is
/// not shaped like a clippings entry at all.
fn read_entry(lines: &[&str], parsed: &mut Parsed) {
    // Kindle pads the block with blank lines around the separator.
    let lines: Vec<&str> = lines.iter().copied().map(str::trim).collect();
    let Some(start) = lines.iter().position(|line| !line.is_empty()) else {
        return;
    };
    let lines = &lines[start..];
    if lines.len() < 2 || !lines[1].starts_with('-') {
        return;
    }

    match kind(lines[1]) {
        Kind::Highlight => {}
        Kind::Note => {
            parsed.notes += 1;
            return;
        }
        Kind::Bookmark => {
            parsed.bookmarks += 1;
            return;
        }
        // A line the device wrote in a shape we do not know is not worth
        // guessing at.
        Kind::Unknown => return,
    }

    let text = collapse(&lines[2..].join("\n"));
    if text.is_empty() {
        return;
    }
    let (title, author) = split_title_author(lines[0]);
    parsed.highlights.push(Clipping { title, author, text });
}

fn kind(meta: &str) -> Kind {
    let ascii = meta.to_ascii_lowercase();
    if ascii.contains("bookmark") || meta.contains("书签") {
        return Kind::Bookmark;
    }
    if ascii.contains("note") || meta.contains("笔记") {
        return Kind::Note;
    }
    if ascii.contains("highlight") || meta.contains("标注") || meta.contains("高亮") {
        return Kind::Highlight;
    }
    Kind::Unknown
}

/// Splits Kindle's `Title (Author)` line. The author is the trailing
/// parenthesised group, so a title carrying parentheses of its own still
/// splits in the right place; a line without one is all title.
pub fn split_title_author(line: &str) -> (String, String) {
    let line = line.trim();
    if let Some(open) = line.strip_suffix(')').and_then(|head| head.rfind('(')) {
        let title = line[..open].trim();
        let author = line[open + 1..line.len() - 1].trim();
        if !title.is_empty() && !author.is_empty() {
            return (title.to_string(), author.to_string());
        }
    }
    (line.to_string(), String::new())
}

/// Squeezes every whitespace run — including the line breaks Kindle keeps
/// inside a multi-paragraph highlight — into a single space.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            gap = !out.is_empty();
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(ch);
    }
    out
}

/// Characters that carry no ink of their own and that the two sides of a match
/// may legitimately disagree about.
fn ignorable(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(ch, '\u{00ad}' | '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}')
}

/// A chapter body reduced once, then searched by every clipping of that book.
///
/// [`locate`]: Haystack::locate
struct Haystack {
    /// The text with the ignorable characters taken out, one entry per UTF-16
    /// code unit (annotation offsets are UTF-16, so these are too).
    units: Vec<u16>,
    /// The original UTF-16 span each unit came from, parallel to `units`.
    spans: Vec<(u32, u32)>,
}

impl Haystack {
    fn new(text: &str) -> Self {
        let mut units = Vec::with_capacity(text.len());
        let mut spans = Vec::with_capacity(text.len());
        let mut at = 0u32;
        let mut buf = [0u16; 2];
        for ch in text.chars() {
            if !ignorable(ch) {
                for (offset, unit) in ch.encode_utf16(&mut buf).iter().enumerate() {
                    units.push(*unit);
                    let start = at + offset as u32;
                    spans.push((start, start + 1));
                }
            }
            at += ch.len_utf16() as u32;
        }
        Self { units, spans }
    }

    /// The UTF-16 range `needle` occupies in the original text, if it is there.
    fn locate(&self, needle: &str) -> Option<(usize, usize)> {
        let mut wanted: Vec<u16> = Vec::with_capacity(needle.len());
        let mut buf = [0u16; 2];
        for ch in needle.chars() {
            if ignorable(ch) {
                continue;
            }
            let len = ch.encode_utf16(&mut buf).len();
            wanted.extend_from_slice(&buf[..len]);
        }
        if wanted.is_empty() || wanted.len() > self.units.len() {
            return None;
        }
        let at = self.units.windows(wanted.len()).position(|window| window == wanted)?;
        Some((self.spans[at].0 as usize, self.spans[at + wanted.len() - 1].1 as usize))
    }
}

/// Comparison key for "the same highlight, twice": case- and
/// whitespace-insensitive, so a re-imported file and the rows already stored
/// agree even though one side has line breaks where the other has spaces.
pub fn signature(text: &str) -> String {
    text.chars().filter(|ch| !ignorable(*ch)).flat_map(char::to_lowercase).collect()
}

/// The shelf, indexed for title lookup.
pub struct Catalog {
    entries: Vec<Entry>,
}

struct Entry {
    id: String,
    key: String,
    authors: String,
}

impl Catalog {
    pub fn new(books: impl IntoIterator<Item = (String, String, String)>) -> Self {
        let entries = books
            .into_iter()
            .map(|(id, title, authors)| Entry {
                id,
                key: signature(&title),
                authors: signature(&authors),
            })
            .collect();
        Self { entries }
    }

    /// The book a clipping came from, or `None` when the shelf has no
    /// unambiguous candidate.
    pub fn lookup(&self, title: &str, author: &str) -> Option<&str> {
        let key = signature(title);
        if key.is_empty() {
            return None;
        }
        let author = signature(author);

        // An identical title is strong evidence, so it wins even when the shelf
        // holds the book twice; the author only decides between two books that
        // share the title.
        let exact: Vec<&Entry> = self.entries.iter().filter(|entry| entry.key == key).collect();
        if let Some(entry) = by_author(&exact, &author).or_else(|| exact.first().copied()) {
            return Some(entry.id.as_str());
        }

        // Otherwise Kindle's title carries something the shelf dropped, or the
        // other way round: `Sapiens: A Brief History of Humankind` against
        // `Sapiens`. Only one direction of prefix, and never on a stub of a
        // title, or short books would match each other.
        let guessed: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|entry| {
                let (short, long) = if entry.key.chars().count() <= key.chars().count() {
                    (&entry.key, &key)
                } else {
                    (&key, &entry.key)
                };
                short.chars().count() >= 6 && long.starts_with(short.as_str())
            })
            .collect();
        if guessed.len() == 1 {
            return Some(guessed[0].id.as_str());
        }
        by_author(&guessed, &author).map(|entry| entry.id.as_str())
    }
}

/// The unique candidate the author points at, if there is one.
fn by_author<'a>(candidates: &[&'a Entry], author: &str) -> Option<&'a Entry> {
    if author.is_empty() {
        return None;
    }
    let mut matches = candidates.iter().filter(|entry| {
        !entry.authors.is_empty()
            && (entry.authors.contains(author) || author.contains(entry.authors.as_str()))
    });
    let first = *matches.next()?;
    matches.next().is_none().then_some(first)
}

/// What the dialog renders: before the import as a preview, after it as the
/// receipt. Both come out of the same run.
#[derive(specta::Type, Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// Highlight entries in the file, notes and bookmarks excluded.
    pub total: usize,
    pub notes: usize,
    pub bookmarks: usize,
    /// Highlights whose book is on the shelf.
    pub matched: usize,
    /// Of those, the ones whose text was found in the book and anchored.
    pub located: usize,
    /// Highlights that were not already in the library, so a preview reports
    /// exactly what a real run writes and the confirm button can show it.
    pub imported: usize,
    /// Already in the library from an earlier import of the same file.
    pub duplicates: usize,
    pub books: Vec<BookOutcome>,
    pub unknown_titles: Vec<String>,
}

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookOutcome {
    pub book_id: String,
    pub title: String,
    pub total: usize,
    pub imported: usize,
    pub duplicates: usize,
    /// Text the book no longer contains, so nothing could be anchored.
    pub unlocated: usize,
}

/// Turns a parsed file into annotations. `dry_run` walks the same path and
/// writes nothing, which is what the confirm step shows.
pub fn import(conn: &Connection, parsed: &Parsed, dry_run: bool) -> AppResult<Outcome> {
    let catalog = Catalog::new(shelf(conn)?);
    let mut outcome = Outcome {
        total: parsed.highlights.len(),
        notes: parsed.notes,
        bookmarks: parsed.bookmarks,
        ..Outcome::default()
    };

    // The report keeps the order books were first seen in, which is the order
    // the reader will scroll them in.
    let mut indexes: HashMap<String, usize> = HashMap::new();
    let mut seen_titles: HashSet<String> = HashSet::new();
    let mut haystacks: HashMap<String, Option<Vec<(usize, Haystack)>>> = HashMap::new();
    // Text already stored for the book, so importing the same file twice is a
    // no-op instead of a second copy of every highlight.
    let mut taken: HashMap<String, HashSet<String>> = HashMap::new();

    for clipping in &parsed.highlights {
        let Some(book_id) = catalog.lookup(&clipping.title, &clipping.author) else {
            let title = clipping.title.trim().to_string();
            if seen_titles.insert(signature(&title))
                && outcome.unknown_titles.len() < MAX_UNKNOWN_TITLES
                && !title.is_empty()
            {
                outcome.unknown_titles.push(title);
            }
            continue;
        };
        let book_id = book_id.to_string();

        let at = match indexes.get(&book_id) {
            Some(at) => *at,
            None => {
                let at = outcome.books.len();
                indexes.insert(book_id.clone(), at);
                outcome.books.push(BookOutcome {
                    book_id: book_id.clone(),
                    title: clipping.title.trim().to_string(),
                    total: 0,
                    imported: 0,
                    duplicates: 0,
                    unlocated: 0,
                });
                at
            }
        };
        outcome.matched += 1;
        outcome.books[at].total += 1;

        if !haystacks.contains_key(&book_id) {
            haystacks.insert(book_id.clone(), chapters(conn, &book_id)?);
        }
        // Chapters are read once per book; a book whose text could not be read
        // anchors nothing, which the report already covers as "unlocated".
        let located =
            haystacks[&book_id].as_ref().and_then(|chapters| locate(chapters, &clipping.text));

        let Some((chapter_idx, start, end)) = located else {
            outcome.books[at].unlocated += 1;
            continue;
        };
        outcome.located += 1;

        if !taken.contains_key(&book_id) {
            let existing = annotations::list(conn, &book_id)?;
            taken.insert(
                book_id.clone(),
                existing.iter().map(|annotation| signature(&annotation.text)).collect(),
            );
        }
        let signature = signature(&clipping.text);
        if taken[&book_id].contains(&signature) {
            outcome.duplicates += 1;
            outcome.books[at].duplicates += 1;
            continue;
        }

        if !dry_run {
            annotations::create(
                conn,
                &book_id,
                chapter_idx,
                start,
                end,
                &clipping.text,
                // A CFI is the reader's to mint: only it has the book loaded.
                None,
                None,
                None,
            )?;
        }
        taken.get_mut(&book_id).expect("seeded above").insert(signature);
        outcome.imported += 1;
        outcome.books[at].imported += 1;
    }

    Ok(outcome)
}

/// The shelf as `(id, title, authors)`.
fn shelf(conn: &Connection) -> AppResult<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, COALESCE((
             SELECT group_concat(a.name, '; ')
             FROM book_authors ba JOIN authors a ON a.id = ba.author_id
             WHERE ba.book_id = b.id
         ), '')
         FROM books b",
    )?;
    let mut rows = stmt.query([])?;
    let mut books = Vec::new();
    while let Some(row) = rows.next()? {
        books.push((row.get(0)?, row.get(1)?, row.get(2)?));
    }
    Ok(books)
}

/// Every chapter body of a book, ready to be searched.
fn chapters(conn: &Connection, book_id: &str) -> AppResult<Option<Vec<(usize, Haystack)>>> {
    let mut stmt =
        conn.prepare("SELECT idx, content FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
    let mut rows = stmt.query(params![book_id])?;
    let mut chapters = Vec::new();
    while let Some(row) = rows.next()? {
        // `idx` is an integer column; annotation rows carry it as a `usize`.
        let idx = row.get::<_, i64>(0)?.max(0) as usize;
        let content = row.get::<_, String>(1)?;
        chapters.push((idx, Haystack::new(&content)));
    }
    Ok((!chapters.is_empty()).then_some(chapters))
}

/// The chapter holding this text, if any.
fn locate(chapters: &[(usize, Haystack)], needle: &str) -> Option<(usize, usize, usize)> {
    for (idx, haystack) in chapters {
        if let Some((start, end)) = haystack.locate(needle) {
            return Some((*idx, start, end));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    /// One entry, exactly as a Kindle writes it.
    fn entry(title: &str, meta: &str, body: &str) -> String {
        format!("{title}\n{meta}\n\n{body}\n==========\n")
    }

    fn highlight(title: &str, body: &str) -> String {
        entry(
            title,
            "- Your Highlight on page 12 | Location 1234-1237 | Added on Monday, January 1, 2018 10:30:00 AM",
            body,
        )
    }

    #[test]
    fn parses_highlights_and_counts_the_rest() {
        let source = format!(
            "{}{}{}",
            highlight("Sapiens (Yuval Noah Harari)", "The first sentence."),
            entry(
                "Sapiens (Yuval Noah Harari)",
                "- Your Note on page 12 | Location 1240 | Added on Monday, January 1, 2018 10:31:00 AM",
                "My own thought."
            ),
            entry(
                "Sapiens (Yuval Noah Harari)",
                "- Your Bookmark on page 40 | Location 4000 | Added on Monday, January 1, 2018 11:00:00 AM",
                ""
            ),
        );
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "The first sentence.");
        assert_eq!(parsed.highlights[0].title, "Sapiens");
        assert_eq!(parsed.highlights[0].author, "Yuval Noah Harari");
        assert_eq!(parsed.notes, 1);
        assert_eq!(parsed.bookmarks, 1);
    }

    #[test]
    fn a_bom_and_crlf_do_not_get_in_the_way() {
        let source = format!(
            "\u{feff}{}",
            highlight("Piranesi (Susanna Clarke)", "The Beauty of the House is immeasurable.")
        )
        .replace('\n', "\r\n");
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].title, "Piranesi");
        assert_eq!(parsed.highlights[0].text, "The Beauty of the House is immeasurable.");
    }

    #[test]
    fn the_last_entry_needs_no_trailing_separator() {
        let source = "Piranesi (Susanna Clarke)\n- Your Highlight at location 1-2 | Added on Monday, January 1, 2018 10:30:00 AM\n\nA last line.\n";
        let parsed = parse(source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "A last line.");
    }

    #[test]
    fn a_multi_paragraph_highlight_is_one_entry() {
        let source =
            highlight("Piranesi (Susanna Clarke)", "First paragraph.\n\nSecond paragraph.");
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "First paragraph. Second paragraph.");
    }

    #[test]
    fn a_ragged_file_is_skipped_not_fatal() {
        let source = format!(
            "junk without a metadata line\n\nnoise\n==========\n{}",
            highlight("Piranesi (Susanna Clarke)", "The real one.")
        );
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "The real one.");
    }

    #[test]
    fn titles_split_at_the_trailing_parenthesis() {
        assert_eq!(
            split_title_author("The Art of War (Illustrated) (Sun Tzu)"),
            ("The Art of War (Illustrated)".into(), "Sun Tzu".into())
        );
        assert_eq!(
            split_title_author("Piranesi (Susanna Clarke)"),
            ("Piranesi".into(), "Susanna Clarke".into())
        );
        assert_eq!(
            split_title_author("An Anonymous Book"),
            ("An Anonymous Book".into(), "".into())
        );
        // Kindle separates the two with a space, so a title that itself ends in
        // parentheses and a title with an author are the same line. The format
        // wins: an author is far more common than a book whose title ends in a
        // bracket, and the split keeps the author available for matching.
        assert_eq!(split_title_author("What (is this)"), ("What".into(), "is this".into()));
    }

    #[test]
    fn locating_ignores_the_whitespace_the_two_sides_disagree_about() {
        // The book breaks the paragraph; the clipping does not.
        let haystack = Haystack::new("and the House\n  said:  hello");
        assert_eq!(haystack.locate("the House said: hello"), Some((4, 28)));
        assert_eq!(haystack.locate("nothing here"), None);
        assert_eq!(haystack.locate(""), None);
    }

    #[test]
    fn locating_survives_soft_hyphens_the_clipping_lacks() {
        let haystack = Haystack::new("imme\u{00ad}asurable");
        assert_eq!(haystack.locate("immeasurable"), Some((0, 13)));
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        // Each of these is one character but two UTF-16 units, so a byte- or
        // char-counted offset would be half of the real one.
        let haystack = Haystack::new("中文切分");
        assert_eq!(haystack.locate("切分"), Some((2, 4)));
    }

    #[test]
    fn a_catalog_prefers_the_author_when_a_title_repeats() {
        let catalog = Catalog::new(vec![
            ("a".into(), "Piranesi".into(), "Susanna Clarke".into()),
            ("b".into(), "Piranesi".into(), "Someone Else".into()),
        ]);
        assert_eq!(catalog.lookup("Piranesi", "Susanna Clarke"), Some("a"));
        assert_eq!(catalog.lookup("Piranesi", "Someone Else"), Some("b"));
        // No author to go on: an identical title still beats no match at all.
        assert_eq!(catalog.lookup("Piranesi", ""), Some("a"));
    }

    #[test]
    fn a_catalog_matches_a_subtitle_the_shelf_dropped() {
        let catalog =
            Catalog::new(vec![("a".into(), "Sapiens".into(), "Yuval Noah Harari".into())]);
        assert_eq!(
            catalog.lookup("Sapiens: A Brief History of Humankind", "Yuval Noah Harari"),
            Some("a")
        );
        assert_eq!(catalog.lookup("Sapie", ""), None);
        assert_eq!(catalog.lookup("", ""), None);
    }

    #[test]
    fn a_short_title_does_not_match_a_longer_one() {
        let catalog = Catalog::new(vec![("a".into(), "War".into(), "".into())]);
        assert_eq!(catalog.lookup("War and Peace", ""), None);
    }

    #[test]
    fn an_ambiguous_prefix_matches_nothing() {
        // Both titles are a prefix of the clipping's, so the fallback has no
        // way to choose and must not guess.
        let catalog = Catalog::new(vec![
            ("a".into(), "The Great Book".into(), "".into()),
            ("b".into(), "The Great Book of Everything".into(), "".into()),
        ]);
        assert_eq!(catalog.lookup("The Great Book of Everything and More", ""), None);
        assert_eq!(catalog.lookup("The Great Book of Everything Else", "Somebody Else"), None);
    }

    /// A library holding one book with two chapters.
    fn seeded() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
             file_size, added_at, updated_at) \
             VALUES ('b', 'Piranesi', 'piranesi', 'epub', 'h', '/b.epub', 1, 0, 0)",
            [],
        )
        .expect("insert book");
        conn.execute(
            "INSERT INTO chapters (book_id, idx, title, content, chars) \
             VALUES ('b', 0, 'One', 'The Beauty of the House is immeasurable; its Kindness infinite.', 60)",
            [],
        )
        .expect("insert chapter");
        conn.execute(
            "INSERT INTO chapters (book_id, idx, title, content, chars) \
             VALUES ('b', 1, 'Two', 'The Moon rose over the Halls.', 27)",
            [],
        )
        .expect("insert chapter");
        conn
    }

    fn clippings_of(pairs: &[(&str, &str)]) -> Parsed {
        Parsed {
            highlights: pairs
                .iter()
                .map(|(title, text)| Clipping {
                    title: (*title).into(),
                    author: "Susanna Clarke".into(),
                    text: (*text).into(),
                })
                .collect(),
            notes: 0,
            bookmarks: 0,
        }
    }

    #[test]
    fn an_import_anchors_highlights_into_their_chapter() {
        let library = seeded();
        let parsed = clippings_of(&[
            ("Piranesi", "The Beauty of the House"),
            ("Piranesi", "The Moon rose over the Halls."),
            // Not in the book: counted, not written.
            ("Piranesi", "A line this book does not contain."),
        ]);
        let outcome = import(&library, &parsed, false).expect("import");
        assert_eq!(outcome.total, 3);
        assert_eq!(outcome.matched, 3);
        assert_eq!(outcome.located, 2);
        assert_eq!(outcome.imported, 2);
        assert_eq!(outcome.duplicates, 0);
        assert_eq!(outcome.books.len(), 1);
        assert_eq!(outcome.books[0].unlocated, 1);

        let rows = annotations::list(&library, "b").expect("list");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].chapter_idx, 0);
        assert_eq!(rows[0].start_char, 0);
        assert_eq!(rows[0].end_char, 23);
        assert_eq!(rows[1].chapter_idx, 1);
        assert_eq!(rows[1].start_char, 0);
        // The reader mints the CFI; the backend must not invent one.
        assert!(rows[0].cfi.is_none());
    }

    #[test]
    fn a_preview_writes_nothing() {
        let library = seeded();
        let parsed = clippings_of(&[("Piranesi", "The Moon rose over the Halls.")]);
        let outcome = import(&library, &parsed, true).expect("preview");
        // A preview reports what a real run would do, ...
        assert_eq!(outcome.located, 1);
        assert_eq!(outcome.imported, 1);
        // ... and none of it reaches the database.
        assert_eq!(annotations::list(&library, "b").expect("list").len(), 0);
    }

    #[test]
    fn importing_the_same_file_twice_adds_nothing() {
        let library = seeded();
        let parsed = clippings_of(&[("Piranesi", "The Beauty of the House")]);
        import(&library, &parsed, false).expect("first");
        let again = import(&library, &parsed, false).expect("second");
        assert_eq!(again.imported, 0);
        assert_eq!(again.duplicates, 1);
        assert_eq!(annotations::list(&library, "b").expect("list").len(), 1);
    }

    #[test]
    fn a_duplicate_inside_one_file_is_imported_once() {
        let library = seeded();
        let parsed = clippings_of(&[
            ("Piranesi", "The Moon rose over the Halls."),
            ("Piranesi", "The Moon rose over the Halls."),
        ]);
        let outcome = import(&library, &parsed, false).expect("import");
        assert_eq!(outcome.imported, 1);
        assert_eq!(outcome.duplicates, 1);
    }

    #[test]
    fn a_book_the_shelf_never_got_is_reported_by_title() {
        let library = seeded();
        let parsed =
            clippings_of(&[("Some Other Book", "A line."), ("Some Other Book", "Another line.")]);
        let outcome = import(&library, &parsed, false).expect("import");
        assert_eq!(outcome.matched, 0);
        assert_eq!(outcome.unknown_titles, vec!["Some Other Book".to_string()]);
        assert!(outcome.books.is_empty());
    }
}
