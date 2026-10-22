//! What a parsed file becomes: annotations, and the report the dialog shows.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use super::Parsed;
use super::anchor::{Catalog, Haystack, chapter_haystacks, locate, signature};
use crate::error::AppResult;
use crate::library::annotations;

/// Distinct unknown titles the report carries back. A clippings file from a
/// decade of reading can name hundreds of books the shelf never got; the head
/// of that list is the actionable part.
const MAX_UNKNOWN_TITLES: usize = 12;

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
            haystacks.insert(book_id.clone(), chapter_haystacks(conn, &book_id)?);
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

#[cfg(test)]
mod tests {
    use super::super::{Clipping, parse_csv};
    use super::*;
    use crate::db::migrations;

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
             1,The Moon rose over the Halls.,,,,fangce://book/b?annotation=a1\n",
        );
        assert_eq!(parsed.highlights[0].title, "", "旧表本来就没有书名列");

        let outcome = import(&library, &parsed, false).expect("import");
        assert_eq!(outcome.matched, 1);
        assert_eq!(outcome.imported, 1);
        assert_eq!(outcome.books[0].book_id, "b");
        // The shelf's own title, not the file's empty one.
        assert_eq!(outcome.books[0].title, "Piranesi");
    }
}
