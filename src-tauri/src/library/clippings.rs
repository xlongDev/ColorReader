//! Reading highlights back in — from Kindle, and from this app's own exports.
//!
//! Three shapes, told apart by [`detect`] from their content rather than their
//! name: Kindle's `My Clippings.txt`, and the Markdown and CSV files
//! [`crate::library::export`] writes. All three come out as the same
//! [`Clipping`]s and go through the same [`import`], so the report, the
//! de-duplication and the anchoring are one code path.
//!
//! What each source knows differs, and nothing is invented to paper over it. A
//! Kindle entry is a title, an author and a passage. An export adds the reader's
//! own note, the ink and the chapter the highlight sits in — which turns the
//! search from "every chapter" into "the one it names" — and the CSV adds the
//! paint style as well. The Markdown has no colour in it at all, because it is
//! written to be read as a page rather than parsed.
//!
//! An export also links back to the book it came from, and that link is the
//! strongest thing either source carries: it names the book by id, so a renamed
//! book still matches and a shelf holding the same title twice is not a coin
//! toss. `Catalog::lookup` — the title path, all a Kindle file can offer —
//! resolves a repeated title by taking the first, which is fine as a fallback
//! and not good enough when the file knows.
//!
//! The Kindle `My Clippings.txt` case, in detail: the file knows a highlight's
//! *text* and a `位置 #1234-1237` line number, and nothing else. The line number
//! counts positions inside the file Amazon shipped, which is not the file we
//! have: a re-imported AZW3, an EPUB from elsewhere, a re-flowed TXT all number
//! their positions differently. So the text is the only anchor that survives,
//! and that is what this module matches on — every clipping is located by
//! finding its text in the chapter bodies we already store for full-text search.
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
///
/// The first three fields are all a Kindle file carries. The rest are what this
/// app's own exports add on top — the reader's note, the ink, the shape, the
/// chapter the highlight sits in, and the book it came from — and they stay
/// `None` for a Kindle file rather than being invented.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Clipping {
    pub title: String,
    pub author: String,
    pub text: String,
    /// The book id this app's own export links back to, when the file carries
    /// the link.
    ///
    /// Worth more than the title, which is only what the shelf *called* the book
    /// when the file was written: a renamed book still matches, and a shelf
    /// holding the same title twice — two editions, a re-import — is no longer
    /// a coin toss. `Catalog::lookup` says as much from its own side: an
    /// identical title "wins even when the shelf holds the book twice", which is
    /// the best a Kindle file can do and a poor excuse for a file that knows.
    pub book_id: Option<String>,
    /// The reader's own note on this highlight. A Kindle clippings file keeps
    /// notes as separate entries with no text of their own, so this is only
    /// ever set by an export.
    pub note: Option<String>,
    /// Ink and paint style, same story.
    pub color: Option<String>,
    pub style: Option<String>,
    /// The chapter the file says the highlight is in.
    ///
    /// Worth more than it looks: it turns "search every chapter for this
    /// sentence" into "search the one chapter the reader marked it in", which
    /// is both cheaper and correct when the same sentence occurs twice in a
    /// book. A Kindle file does not say, so this is `None` there.
    pub chapter_idx: Option<usize>,
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

/// Which of the three shapes a file is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Kindle's `My Clippings.txt`.
    Kindle,
    /// This app's own Markdown export.
    Markdown,
    /// This app's own CSV export.
    Csv,
}

/// The scheme and path every highlight in an export links back through.
const LINK_PREFIX: &str = "colorreader://book/";

/// The book id an export's link names, or `None` when the line carries no link.
///
/// The shape is `colorreader://book/<book id>?annotation=<highlight id>`, which
/// `export::link` writes and `src/lib/deeplink.ts` parses from the other end.
/// The query is dropped here: this is asking which book, not which highlight.
///
/// Searched for rather than matched at the start: in the Markdown the link is
/// wrapped in `[在 ColorReader 中打开](…)`, and a reader who pasted the file
/// through something that rewrote the wrapper should still be matched.
fn linked_book_id(text: &str) -> Option<String> {
    let rest = &text[text.find(LINK_PREFIX)? + LINK_PREFIX.len()..];
    let id = rest.split(['?', ')', ']', ' ']).next().unwrap_or("").trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// Says what a file is from what is *in* it, never from its name.
///
/// The reader picks the file in a native panel and may well have renamed it, so
/// a wrong extension is not a reason to fail at. All three shapes announce
/// themselves in their first lines.
///
/// Order matters, and the header has to be looked at first: a CSV export carries
/// the same `colorreader://` link on every row that a Markdown one does, so
/// asking "does this mention a link?" before "is this a table?" calls every CSV
/// a Markdown file. (Measured: it did.) The header row is unambiguous — a table
/// opens with column names, and neither of the other two shapes can.
pub fn detect(source: &str) -> Shape {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let first = source.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
    if header_of(first).is_some() {
        return Shape::Csv;
    }
    // An export with nothing in it carries no link, so the heading is then the
    // only thing left to go on. Kindle's first line is `Title (Author)` and
    // never starts with a hash.
    if source.contains(LINK_PREFIX) || first.starts_with('#') {
        return Shape::Markdown;
    }
    Shape::Kindle
}

/// The column names of an export's header row, or `None` when the line is not
/// one.
///
/// `原文` is what makes a table an export at all; a title or a chapter is what
/// makes a row findable. Columns are read *by name* rather than by position, so
/// a table that gains one is read for the rest instead of refused — which is
/// what lets the two sides move independently (`export::CSV_HEADER` is the
/// writer's half of the same agreement).
fn header_of(line: &str) -> Option<Vec<String>> {
    let fields = csv_rows(line).into_iter().next()?;
    let named = |want: &str| fields.iter().any(|field| field.trim() == want);
    (named("原文") && (named("章节") || named("书名"))).then_some(fields)
}

/// Reads this app's own Markdown export back into highlights.
///
/// The file is written to be *read* — a quoted passage, the note under it, a
/// link home — so the parse is a small state machine over those blocks rather
/// than a table lookup. Three things make it tractable:
///
/// - Headings are told apart by their *text*, not their level. `## 第 3 章` is a
///   chapter in a single-book file and `## 《书名》` is a book in a cross-book
///   one, so the level means nothing on its own.
/// - The quoted passage is the run of `> ` lines at the start of an entry, and
///   everything between that run and the link is the note. A note that itself
///   opens with `> ` would be swallowed into the passage; that is the one shape
///   this cannot read, and it is worth less than the alternative (a note
///   containing a line break splitting the entry in two).
/// - The link is *optional*. A file pasted through a note app may come back
///   with the links dropped, and a highlight without its link is still a
///   highlight — a heading ends the entry just as well.
///
/// Ink and shape are not in the Markdown at all; only the CSV carries them. So
/// a Markdown import brings back what was read and what was written about it,
/// and a CSV import also brings back the colour.
pub fn parse_markdown(source: &str) -> Parsed {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let normalised = source.replace("\r\n", "\n").replace('\r', "\n");

    let mut parsed = Parsed::default();
    let mut title = String::new();
    let mut chapter: Option<usize> = None;
    let mut passage: Vec<String> = Vec::new();
    let mut note: Vec<String> = Vec::new();
    // Once the quote has ended, everything is the note — including lines that
    // happen to start with `> `.
    let mut in_note = false;

    let flush = |passage: &mut Vec<String>,
                 note: &mut Vec<String>,
                 in_note: &mut bool,
                 title: &str,
                 chapter: Option<usize>,
                 parsed: &mut Parsed| {
        let text = passage.join("\n").trim().to_string();
        let written = note.join("\n").trim().to_string();
        // Cleared either way: a heading that ends an entry with nothing in it
        // (the summary line under a title, say) must not leave its text lying
        // around for the next entry to pick up.
        passage.clear();
        note.clear();
        *in_note = false;
        if text.is_empty() {
            return;
        }
        parsed.highlights.push(Clipping {
            title: title.to_string(),
            // The line under a book heading is the author in a cross-book file
            // and a summary in a single-book one, and the two cannot be told
            // apart without knowing which shape this is. So the author is not
            // read at all: the title came out of the same database and is exact,
            // and `Catalog` matches on it alone.
            author: String::new(),
            // Stamped by the caller when the link line arrives: the link closes
            // the entry, so it is not known yet at the moment this runs.
            book_id: None,
            text,
            note: (!written.is_empty()).then_some(written),
            color: None,
            style: None,
            chapter_idx: chapter,
        });
    };

    for line in normalised.lines() {
        if let Some(heading) = line.strip_prefix('#') {
            let heading = heading.trim_start_matches('#').trim();
            if let Some(idx) = chapter_number(heading) {
                // A new chapter ends whatever came before it, link or no link.
                flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
                chapter = Some(idx);
            } else {
                flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
                title = heading_title(heading);
                chapter = None;
            }
            continue;
        }
        if line.contains(LINK_PREFIX) {
            let before = parsed.highlights.len();
            flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
            // The link closes the entry above it, so it is stamped onto the
            // highlight `flush` just pushed — and only when it pushed one. An
            // entry that ended at a heading instead would otherwise hand its id
            // to its predecessor.
            if parsed.highlights.len() > before {
                parsed.highlights.last_mut().expect("just pushed").book_id = linked_book_id(line);
            }
            continue;
        }
        if let Some(quoted) = line.strip_prefix("> ") {
            if in_note {
                note.push(line.to_string());
            } else {
                passage.push(quoted.to_string());
            }
            continue;
        }
        // A bare `>` is an empty line inside the quote, which `quote` writes as
        // `> ` and a hand-edited file may write without the space.
        if line.trim() == ">" && !in_note {
            passage.push(String::new());
            continue;
        }
        if line.trim().is_empty() {
            // The blank between the quote and the note. Inside the note, a
            // blank is part of it.
            if !passage.is_empty() {
                in_note = true;
            }
            if in_note {
                note.push(String::new());
            }
            continue;
        }
        in_note = true;
        note.push(line.to_string());
    }
    flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
    parsed
}

/// Reads this app's own CSV export back into highlights.
///
/// Straight from the header: every column is found by name. That is not
/// decoration — it is why adding a column to the writer cannot break this
/// reader, and why a hand-trimmed table that dropped one still reads for the
/// rest.
pub fn parse_csv(source: &str) -> Parsed {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut rows = csv_rows(source).into_iter();
    let Some(header) = rows.next() else {
        return Parsed::default();
    };
    let column = |want: &str| header.iter().position(|field| field.trim() == want);
    let Some(text_at) = column("原文") else {
        return Parsed::default();
    };
    let (title_at, chapter_at) = (column("书名"), column("章节"));
    let (note_at, color_at, style_at) = (column("笔记"), column("颜色"), column("样式"));
    let link_at = column("链接");

    let mut parsed = Parsed::default();
    for row in rows {
        let field = |at: Option<usize>| at.and_then(|at| row.get(at)).map_or("", String::as_str);
        // Kept verbatim, not collapsed the way a Kindle highlight is: this text
        // came out of our own `annotations` table, so its line breaks are the
        // reader's own and re-writing them as spaces would edit the passage.
        let text = field(Some(text_at)).trim().to_string();
        if text.is_empty() {
            continue;
        }
        parsed.highlights.push(Clipping {
            title: field(title_at).trim().to_string(),
            author: String::new(),
            // The link is what makes an old single-book export importable: it
            // was written before `书名` led every table, so the id it carries is
            // the only thing in the file that names the book.
            book_id: linked_book_id(field(link_at)),
            text,
            note: non_empty(field(note_at)),
            // Empty means "never chose", which is not the same fact as yellow —
            // `export::csv_row` leaves the column blank for the same reason.
            color: non_empty(field(color_at)),
            style: non_empty(field(style_at)),
            // Written one-based, like the Markdown heading and like the notes
            // page; annotations count from zero.
            chapter_idx: field(chapter_at)
                .trim()
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1)),
        });
    }
    parsed
}

/// The book a heading names, or empty when it names none.
fn heading_title(text: &str) -> String {
    let Some(open) = text.find('《') else {
        return String::new();
    };
    let Some(close) = text[open..].find('》') else {
        return String::new();
    };
    text[open + '《'.len_utf8()..open + close].trim().to_string()
}

/// The chapter a heading names, as the zero-based index annotations use.
///
/// Both exports write `第 N 章` with `N = idx + 1`, a number and never a title:
/// a title looked up by that index would be off by however much the two lists
/// differ (see `export`). This reads the number back.
fn chapter_number(text: &str) -> Option<usize> {
    let rest = text.trim().strip_prefix('第')?;
    rest.strip_suffix('章')?.trim().parse::<usize>().ok()?.checked_sub(1)
}

/// A CSV field as an optional value: an empty column is an absent fact.
fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Splits a whole CSV source into rows of fields.
///
/// RFC 4180 as the writer on the other side produces it: a `"` quotes a field
/// that may then hold the delimiter, a line break, or a doubled `""` for one
/// literal quote. Written out rather than pulled in — it is forty lines with one
/// caller, and the alternative is a dependency for one import path.
///
/// This has to be exact rather than lenient. `export::csv_field` quotes a
/// passage exactly when it holds one of those three characters, and a reader
/// that split on commas anyway would silently turn one highlight into two
/// fragments of itself.
fn csv_rows(source: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    // A `"` only opens a quoted field at the start of one; inside a bare field
    // it is a literal quote (what a spreadsheet writes when it is not quoting).
    let mut at_start = true;
    let mut chars = source.chars().peekable();

    while let Some(ch) = chars.next() {
        if quoted {
            match ch {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        field.push('"');
                    } else {
                        quoted = false;
                    }
                }
                _ => field.push(ch),
            }
            continue;
        }
        match ch {
            '"' if at_start => {
                quoted = true;
                at_start = false;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                at_start = true;
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                at_start = true;
            }
            // A stray CR is dropped rather than kept: the field already ends at
            // the LF that follows it.
            '\r' => {}
            _ => {
                field.push(ch);
                at_start = false;
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
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
    parsed.highlights.push(Clipping { title, author, text, ..Clipping::default() });
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
    let books = shelf(conn)?;
    // Id → the shelf's own title. An export's link names its book exactly, and
    // the title is wanted twice over: to match when the link is absent, and to
    // *name* the book in the report — where the file's own title would be stale,
    // or blank for an export written before the CSV led with `书名`.
    //
    // Owned rather than borrowed so `books` can move into the catalog below; the
    // shelf is hundreds of rows, not thousands of highlights.
    let on_shelf: HashMap<String, String> =
        books.iter().map(|(id, title, _)| (id.clone(), title.clone())).collect();
    let catalog = Catalog::new(books);
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
        // The link first, the title second. Our own export knows which book it
        // wrote the highlight from, and that is exact — a renamed book still
        // matches, and a shelf holding the title twice is no longer a coin toss.
        // A link naming a book that has since left the shelf is not an error:
        // the title is still tried, and a book the reader deleted should report
        // as unknown rather than as matched.
        let linked = clipping
            .book_id
            .as_deref()
            .and_then(|id| on_shelf.get(id).map(|title| (id, title.as_str())));
        let matched = linked.or_else(|| {
            catalog.lookup(&clipping.title, &clipping.author).map(|id| (id, clipping.title.trim()))
        });
        let Some((book_id, book_title)) = matched else {
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
                    title: book_title.to_string(),
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
        let located = haystacks[&book_id]
            .as_ref()
            .and_then(|chapters| locate(chapters, &clipping.text, clipping.chapter_idx));

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
            let created = annotations::create(
                conn,
                &book_id,
                chapter_idx,
                start,
                end,
                &clipping.text,
                // A CFI is the reader's to mint: only it has the book loaded.
                None,
                clipping.color.as_deref(),
                clipping.style.as_deref(),
            )?;
            // The note is written as its own step rather than as an argument to
            // `create`, which takes one for the reader's own paths only. It is
            // the same transaction either way (`with_tx` wraps the whole run),
            // so this costs a statement and not a commit.
            if let Some(note) = clipping.note.as_deref() {
                annotations::set_note(conn, &created.id, Some(note))?;
            }
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
///
/// `hint` is the chapter the file itself named, and it is tried first. That
/// matters twice over: it is one chapter searched instead of every one, and it
/// settles the case a text-only search cannot — a sentence that appears in two
/// chapters should anchor in the one the reader actually marked.
fn locate(
    chapters: &[(usize, Haystack)],
    needle: &str,
    hint: Option<usize>,
) -> Option<(usize, usize, usize)> {
    if let Some(hint) = hint
        && let Some((idx, haystack)) = chapters.iter().find(|(idx, _)| *idx == hint)
        && let Some((start, end)) = haystack.locate(needle)
    {
        return Some((*idx, start, end));
    }
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
                    ..Clipping::default()
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

    // ---- this app's own exports, read back ----------------------------------

    /// A file as `export` writes it: blocks joined by a blank line, trailing
    /// newline. Spelled out here rather than imported, so a change to the
    /// writer that the reader does not follow fails in `export`'s own round
    /// trip, where the pair is exercised for real.
    fn blocks(lines: &[&str]) -> String {
        format!("{}\n", lines.join("\n\n"))
    }

    const LINK: &str = "colorreader://book/b1?annotation=a1";

    #[test]
    fn a_file_is_told_apart_by_what_is_in_it() {
        let kindle = highlight("Piranesi (Susanna Clarke)", "The Beauty of the House.");
        assert_eq!(detect(&kindle), Shape::Kindle);

        let markdown = blocks(&["# 《Piranesi》标注与笔记", "> The Beauty of the House."]);
        assert_eq!(detect(&markdown), Shape::Markdown);

        // A cross-book export names no book in its title heading; the link on
        // the entries is what gives it away.
        let many = blocks(&[
            "# 笔记导出",
            "2 本书 · 3 条标注",
            &format!("[在 ColorReader 中打开]({LINK})"),
        ]);
        assert_eq!(detect(&many), Shape::Markdown);

        // An export with nothing in it has neither a link nor a 原文 column —
        // the heading is all that is left, which is why it is checked.
        let empty = blocks(&["# 《Piranesi》标注与笔记", "0 条标注"]);
        assert_eq!(detect(&empty), Shape::Markdown);

        let single = blocks(&[
            "章节,原文,笔记,颜色,样式,链接",
            &format!("1,\"你好\",\"\",\"\",\"\",\"{LINK}\""),
        ]);
        assert_eq!(detect(&single), Shape::Csv);

        let cross = blocks(&["书名,章节,原文,笔记,颜色,样式,链接", "Piranesi,1,你好,,,,"]);
        assert_eq!(detect(&cross), Shape::Csv);

        // A table that is not ours: no 原文 column, so it is not an export and
        // falls through to the Kindle parser, which will find nothing in it.
        assert_eq!(detect("name,size\na,1\n"), Shape::Kindle);
    }

    #[test]
    fn markdown_reads_the_quote_the_note_and_the_chapter() {
        let source = blocks(&[
            "# 《Piranesi》标注与笔记",
            "Susanna Clarke · 2 条标注 · 1 条有笔记",
            "## 第 2 章",
            "> The Moon rose over the Halls.",
            "月亮升起来了",
            &format!("[在 ColorReader 中打开]({LINK})"),
            "> A second one.",
            &format!("[在 ColorReader 中打开]({LINK})"),
        ]);
        let parsed = parse_markdown(&source);

        assert_eq!(parsed.highlights.len(), 2);
        assert_eq!(parsed.highlights[0].title, "Piranesi");
        assert_eq!(parsed.highlights[0].text, "The Moon rose over the Halls.");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("月亮升起来了"));
        // `第 2 章` is index 1 — written one-based, read back zero-based.
        assert_eq!(parsed.highlights[0].chapter_idx, Some(1));
        // The chapter carries to the next entry rather than resetting.
        assert_eq!(parsed.highlights[1].chapter_idx, Some(1));
        assert_eq!(parsed.highlights[1].note, None);
        // A highlight with no note is not a note.
        assert_eq!(parsed.notes, 0);
    }

    #[test]
    fn markdown_reads_a_cross_book_export_as_several_books() {
        let source = blocks(&[
            "# 笔记导出",
            "2 本书 · 2 条标注",
            "## 《Piranesi》",
            "Susanna Clarke",
            "### 第 1 章",
            "> The Beauty of the House.",
            &format!("[在 ColorReader 中打开]({LINK})"),
            "## 《三体》",
            "刘慈欣",
            "### 第 3 章",
            "> 不要回答。",
            &format!("[在 ColorReader 中打开]({LINK})"),
        ]);
        let parsed = parse_markdown(&source);

        let seen: Vec<(&str, Option<usize>)> = parsed
            .highlights
            .iter()
            .map(|clipping| (clipping.title.as_str(), clipping.chapter_idx))
            .collect();
        // The author line between the book heading and the chapter heading is
        // not mistaken for a highlight, and the summary under the file's own
        // title is not either.
        assert_eq!(seen, vec![("Piranesi", Some(0)), ("三体", Some(2))]);
    }

    #[test]
    fn markdown_keeps_a_multi_line_passage_and_note_together() {
        let source = blocks(&[
            "# 《Piranesi》标注与笔记",
            "## 第 1 章",
            "> First line.\n> Second line.",
            "A note that\nspans lines.",
            &format!("[在 ColorReader 中打开]({LINK})"),
        ]);
        let parsed = parse_markdown(&source);

        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "First line.\nSecond line.");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("A note that\nspans lines."));
    }

    #[test]
    fn markdown_still_reads_an_entry_whose_link_was_stripped() {
        // A file pasted through a note app may come back with the links gone.
        // A heading ends the entry just as well, so the highlight survives.
        let source =
            blocks(&["# 《Piranesi》标注与笔记", "## 第 1 章", "> The Beauty of the House."]);
        let parsed = parse_markdown(&source);

        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "The Beauty of the House.");
        assert_eq!(parsed.highlights[0].chapter_idx, Some(0));
    }

    #[test]
    fn csv_reads_both_header_shapes_by_column_name() {
        let single = "章节,原文,笔记,颜色,样式,链接\n1,你好,第三章的伏笔,#ffd12e,,\n";
        let parsed = parse_csv(single);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "你好");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("第三章的伏笔"));
        assert_eq!(parsed.highlights[0].color.as_deref(), Some("#ffd12e"));
        assert_eq!(parsed.highlights[0].style, None);
        assert_eq!(parsed.highlights[0].chapter_idx, Some(0));
        // No 书名 column: the file names its book in its heading, so the row
        // has nothing to say and the parser must not invent one.
        assert_eq!(parsed.highlights[0].title, "");

        let cross = "书名,章节,原文,笔记,颜色,样式,链接\n三体,3,最后一段,,,,\n";
        let parsed = parse_csv(cross);
        assert_eq!(parsed.highlights[0].title, "三体");
        assert_eq!(parsed.highlights[0].chapter_idx, Some(2));
    }

    #[test]
    fn csv_takes_the_columns_it_knows_and_ignores_the_rest() {
        // A column added by a later version is read past, not refused — which
        // is what lets the two export shapes share one reader.
        let source = "书名,章节,原文,笔记,颜色,样式,链接,备注\n三体,1,你好,,#ffd12e,,,\n";
        let parsed = parse_csv(source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "你好");
        assert_eq!(parsed.highlights[0].title, "三体");
    }

    #[test]
    fn csv_survives_a_passage_holding_a_comma_a_quote_and_a_line_break() {
        // The writer quotes exactly these three, so the reader has to unquote
        // exactly these three: a comma split naively would turn one highlight
        // into two fragments of itself.
        let source = "书名,章节,原文,笔记,颜色,样式,链接\n\
                      三体,1,\"你好,世界\",\"他说\"\"不\"\"\",,,\n\
                      三体,1,\"First line.\nSecond line.\",,,,\n";
        let parsed = parse_csv(source);

        assert_eq!(parsed.highlights.len(), 2);
        assert_eq!(parsed.highlights[0].text, "你好,世界");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("他说\"不\""));
        assert_eq!(parsed.highlights[1].text, "First line.\nSecond line.");
    }

    #[test]
    fn a_row_with_no_passage_is_dropped() {
        let source = "章节,原文,笔记,颜色,样式,链接\n1,,只有笔记没有原文,,,\n1,有原文,,,,\n";
        let parsed = parse_csv(source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "有原文");
    }

    /// The link is the exact half of the file, and both shapes carry it.
    #[test]
    fn a_link_names_the_book_it_came_from() {
        let csv = parse_csv(
            "书名,章节,原文,笔记,颜色,样式,链接\n\
             三体,1,你好,,,,colorreader://book/b1?annotation=a1\n",
        );
        assert_eq!(csv.highlights[0].book_id.as_deref(), Some("b1"));

        let markdown = parse_markdown(
            "# 《三体》标注与笔记\n\n\
             3 条标注\n\n\
             ## 第 1 章\n\n\
             > 你好\n\n\
             [在 ColorReader 中打开](colorreader://book/b1?annotation=a1)\n",
        );
        assert_eq!(markdown.highlights[0].book_id.as_deref(), Some("b1"));
        // The query is the highlight, not the book, and is dropped.
        assert_ne!(markdown.highlights[0].book_id.as_deref(), Some("a1"));

        // A file pasted through a note app may come back with the links gone.
        // Nothing is invented in their place.
        let stripped = parse_markdown("# 《三体》标注与笔记\n\n## 第 1 章\n\n> 你好\n");
        assert_eq!(stripped.highlights[0].book_id, None);
    }

    /// The link closes the entry, so it must not leak onto the next one — nor
    /// onto the previous one when the entry it closed held no passage.
    #[test]
    fn a_link_belongs_to_the_entry_above_it_and_to_no_other() {
        let source = "# 《三体》标注与笔记\n\n\
                      ## 第 1 章\n\n\
                      > 第一条\n\n\
                      [在 ColorReader 中打开](colorreader://book/b1?annotation=a1)\n\n\
                      > 第二条\n\n\
                      [在 ColorReader 中打开](colorreader://book/b2?annotation=a2)\n\n\
                      ## 第 2 章\n\n\
                      > 第三条\n";
        let parsed = parse_markdown(source);
        let ids: Vec<Option<&str>> =
            parsed.highlights.iter().map(|entry| entry.book_id.as_deref()).collect();
        assert_eq!(ids, vec![Some("b1"), Some("b2"), None]);
    }

    #[test]
    fn the_named_chapter_is_searched_before_the_rest() {
        // The same sentence in both chapters: the file says which one, so that
        // is the one it anchors in. Without the hint the first chapter would
        // win, and the highlight would land in the wrong place.
        let library = seeded();
        let parsed = Parsed {
            highlights: vec![Clipping {
                title: "Piranesi".into(),
                text: "The Moon rose over the Halls.".into(),
                // Chapter 1 holds it; chapter 0 is where a blind search would
                // have started and found nothing, but the hint has to be the
                // *reason* it lands right, so ask for chapter 1 explicitly.
                chapter_idx: Some(1),
                ..Clipping::default()
            }],
            ..Parsed::default()
        };
        let outcome = import(&library, &parsed, false).expect("import");
        assert_eq!(outcome.imported, 1);
        assert_eq!(outcome.located, 1);

        let stored = annotations::list(&library, "b").expect("list");
        assert_eq!(stored[0].chapter_idx, 1);
    }

    #[test]
    fn an_imported_note_and_ink_come_with_the_highlight() {
        let library = seeded();
        let parsed = Parsed {
            highlights: vec![Clipping {
                title: "Piranesi".into(),
                text: "The Beauty of the House is immeasurable; its Kindness infinite.".into(),
                note: Some("记一下".into()),
                color: Some("#56aee2".into()),
                style: Some("squiggly".into()),
                chapter_idx: Some(0),
                ..Clipping::default()
            }],
            ..Parsed::default()
        };
        let outcome = import(&library, &parsed, false).expect("import");
        assert_eq!(outcome.imported, 1);

        let stored = annotations::list(&library, "b").expect("list");
        assert_eq!(stored[0].note.as_deref(), Some("记一下"));
        assert_eq!(stored[0].color.as_deref(), Some("#56aee2"));
        assert_eq!(stored[0].style.as_deref(), Some("squiggly"));
    }

    /// A second copy of the same book on the shelf.
    fn second_copy(conn: &Connection) {
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
             file_size, added_at, updated_at) \
             VALUES ('b2', 'Piranesi', 'piranesi', 'epub', 'h2', '/b2.epub', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn.execute(
            "INSERT INTO chapters (book_id, idx, title, content, chars) \
             VALUES ('b2', 0, 'One', 'The Beauty of the House is immeasurable; its Kindness infinite.', 60)",
            [],
        )
        .expect("insert chapter");
    }

    /// An export knows which book it wrote the highlight from. The title is only
    /// what the shelf called it at the time, and `Catalog::lookup` says plainly
    /// what it does with a repeated title: it takes the first. That is the best
    /// a Kindle file can do — it is not good enough for a file that knows.
    #[test]
    fn a_link_beats_a_title_the_shelf_holds_twice() {
        let library = seeded();
        second_copy(&library);

        let parsed = Parsed {
            highlights: vec![Clipping {
                title: "Piranesi".into(),
                book_id: Some("b2".into()),
                text: "The Beauty of the House is immeasurable; its Kindness infinite.".into(),
                ..Clipping::default()
            }],
            ..Parsed::default()
        };
        let outcome = import(&library, &parsed, false).expect("import");

        assert_eq!(outcome.imported, 1);
        assert_eq!(outcome.books[0].book_id, "b2", "链接点了名，就不该按书名抽签");
        assert_eq!(annotations::list(&library, "b").expect("list").len(), 0);
        assert_eq!(annotations::list(&library, "b2").expect("list").len(), 1);
    }

    /// An export written before the CSV led with `书名` has no title at all, so
    /// the id in its link is the only thing naming the book — and the report
    /// must still be able to say where the highlights went.
    #[test]
    fn an_older_export_is_matched_by_its_link_alone() {
        let library = seeded();
        let parsed = parse_csv(
            "章节,原文,笔记,颜色,样式,链接\n\
             1,The Moon rose over the Halls.,,,,colorreader://book/b?annotation=a1\n",
        );
        assert_eq!(parsed.highlights[0].title, "", "旧表本来就没有书名列");

        let outcome = import(&library, &parsed, false).expect("import");
        assert_eq!(outcome.matched, 1);
        assert_eq!(outcome.imported, 1);
        assert_eq!(outcome.books[0].book_id, "b");
        // The shelf's own title, not the file's empty one.
        assert_eq!(outcome.books[0].title, "Piranesi");
    }

    /// A link naming a book that has left the shelf is not a match, and not an
    /// error either: the title is still tried, and the row reports as unknown.
    #[test]
    fn a_link_to_a_book_that_is_gone_falls_back_to_the_title() {
        let library = seeded();
        let parsed = Parsed {
            highlights: vec![Clipping {
                title: "Piranesi".into(),
                book_id: Some("deleted".into()),
                text: "The Moon rose over the Halls.".into(),
                ..Clipping::default()
            }],
            ..Parsed::default()
        };
        let outcome = import(&library, &parsed, false).expect("import");

        assert_eq!(outcome.books[0].book_id, "b", "链接指向已删除的书，就退回按书名匹配");
        assert_eq!(outcome.imported, 1);
    }
}
