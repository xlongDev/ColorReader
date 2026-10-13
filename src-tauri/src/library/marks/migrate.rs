//! Moving a reader's marks from one edition of a book to another.
//!
//! Re-importing a file that changed is a *new* book: `content_hash` is the
//! identity key, so a corrected epub lands beside the old edition with nothing
//! carried across — no highlights, no bookmarks, no position. That is the one
//! data loss in this reader that happens when the reader does everything right.
//!
//! The anchor is the highlight's own text, which is exactly how a Kindle
//! clipping is placed (see [`crate::library::clippings`]) — and that pipeline is reused
//! rather than written again: the same haystacks, the same `locate`, the same
//! signature used to skip a highlight already present. A new edition that
//! reworded a paragraph simply fails to locate it, which the report says out
//! loud instead of guessing.

use rusqlite::params;
use serde::Serialize;

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::annotations;
use crate::library::bookmarks;
use crate::library::clippings;

/// What one migration moved.
#[derive(specta::Type, Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    /// Highlights placed in the new edition.
    pub annotations: usize,
    /// Highlights whose text the new edition no longer contains — a rewritten
    /// paragraph, or a passage that was cut. The reader is told this number,
    /// because silently dropping a highlight is worse than not migrating.
    pub unlocated: usize,
    /// Bookmarks carried across.
    pub bookmarks: usize,
    /// Whether the reading position moved. `false` only when the old edition
    /// had never been opened.
    pub progress: bool,
}

/// Copies every mark from `from` to `to`, leaving `from` untouched.
///
/// The caller decides what happens to the old edition afterwards — the usual
/// answer is to delete it, but that is a separate step so a failure here cannot
/// cost the reader the book they were reading.
pub fn migrate(library: &Library, from: &str, to: &str) -> AppResult<Migration> {
    if from == to {
        return Err(AppError::InvalidArgument("不能把一本书迁移到它自己".into()));
    }
    library.with_tx(|tx| {
        let moved = migrate_rows(tx, from, to)?;
        // Marks moved; the old edition's row is the caller's to remove.
        Ok(moved)
    })
}

fn migrate_rows(tx: &rusqlite::Transaction<'_>, from: &str, to: &str) -> AppResult<Migration> {
    let old = annotations::list(tx, from)?;
    let pins = bookmarks::list(tx, from)?;
    // `None` means the new edition has no stored text, which happens when its
    // chapter extraction is still owed (a large PDF). Every highlight then
    // reports as unlocated rather than being dropped without a word.
    let haystacks = clippings::chapter_haystacks(tx, to)?;

    let mut taken: std::collections::HashSet<String> =
        annotations::list(tx, to)?.iter().map(|a| clippings::signature(&a.text)).collect();

    let mut result = Migration { annotations: 0, unlocated: 0, bookmarks: 0, progress: false };
    for annotation in &old {
        let signature = clippings::signature(&annotation.text);
        if taken.contains(&signature) {
            continue;
        }
        let Some((chapter_idx, start, end)) = haystacks.as_ref().and_then(|chapters| {
            clippings::locate(chapters, &annotation.text, Some(annotation.chapter_idx))
        }) else {
            result.unlocated += 1;
            continue;
        };
        let created = annotations::create(
            tx,
            to,
            chapter_idx,
            start,
            end,
            &annotation.text,
            // A CFI points into the *old* file's spine. Re-minting it is the
            // reader's job, the same way it is for a Kindle clipping.
            None,
            annotation.color.as_deref(),
            annotation.style.as_deref(),
        )?;
        if let Some(note) = annotation.note.as_deref() {
            annotations::set_note(tx, &created.id, Some(note))?;
        }
        taken.insert(signature);
        result.annotations += 1;
    }

    for pin in &pins {
        // Chapter numbering is the new edition's own, and the label names the
        // old one; both are carried as-is rather than re-derived, so nothing
        // here pretends to know better than the file it just read.
        bookmarks::create(tx, to, pin.chapter_idx, pin.fraction, &pin.label)?;
        result.bookmarks += 1;
    }

    result.progress = carry_progress(tx, from, to)?;
    carry_shelf_state(tx, from, to)?;
    Ok(result)
}

/// Copies the reading position. `location` is a CFI, so it is *not* carried —
/// a stale CFI lands the reader somewhere in the wrong file, which is worse
/// than landing at the same fraction of the new one.
fn carry_progress(tx: &rusqlite::Transaction<'_>, from: &str, to: &str) -> AppResult<bool> {
    let from_progress: Option<f64> = tx
        .query_row("SELECT progress FROM books WHERE id = ?1", params![from], |row| row.get(0))
        .ok();
    let Some(progress) = from_progress.filter(|p| *p > 0.0) else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE books SET progress = ?2, updated_at = ?3 WHERE id = ?1",
        params![to, progress, crate::library::now_seconds()],
    )?;
    Ok(true)
}

/// The shelf's own idea of the book: favourite flag and tags. Both are the
/// reader's, not the file's, and neither has anything to do with the bytes.
fn carry_shelf_state(tx: &rusqlite::Transaction<'_>, from: &str, to: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE books SET favorite = 1 WHERE id = ?1 AND EXISTS (
             SELECT 1 FROM books WHERE id = ?2 AND favorite = 1
         )",
        params![to, from],
    )?;
    // Tags are shared rows joined to a book, so this is a copy and not a move:
    // the old edition keeps its own until it is removed.
    tx.execute(
        "INSERT OR IGNORE INTO book_tags (book_id, tag_id)
         SELECT ?2, tag_id FROM book_tags WHERE book_id = ?1",
        params![from, to],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;

    fn library(tag: &str) -> (std::path::PathBuf, Library) {
        let dir = fixture::temp_dir(tag);
        let layout = Layout::create(dir.clone()).expect("layout");
        let library = Library::open(&layout.data_dir).expect("open");
        (dir, library)
    }

    fn book(library: &Library, id: &str, title: &str, chapters_: &[&str]) {
        library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                     file_size, added_at, updated_at, progress) \
                     VALUES (?1, ?2, 'x', 'txt', ?1, 'p', 1, 1, 1, 0)",
                    params![id, title],
                )?;
                Ok(())
            })
            .expect("book");
        let raw: Vec<crate::document::RawChapter> = chapters_
            .iter()
            .enumerate()
            .map(|(idx, text)| crate::document::RawChapter {
                title: Some(format!("第 {} 章", idx + 1)),
                paragraphs: vec![(*text).into()],
            })
            .collect();
        library.with_tx(|tx| crate::library::chapters::insert(tx, id, &raw)).expect("chapters");
    }

    #[test]
    fn marks_follow_a_corrected_edition() {
        let (dir, library) = library("migrate-basic");
        // The second edition fixes a typo and adds a paragraph after it.
        book(&library, "v1", "三体", &["他推开 门，走了进去。", "第二章。"]);
        book(&library, "v2", "三体", &["他推开门，走了进去。", "新的一段。", "第二章。"]);
        library
            .with(|conn| {
                annotations::create(
                    conn,
                    "v1",
                    0,
                    0,
                    5,
                    "他推开 门",
                    None,
                    Some("#ffd12e"),
                    Some("underline"),
                )
            })
            .expect("annotate");
        library
            .with(|conn| {
                annotations::set_note(conn, &annotations::list(conn, "v1")?[0].id, Some("开场"))
            })
            .expect("note");
        library.with(|conn| bookmarks::create(conn, "v1", 0, 0.5, "第一章")).expect("bookmark");
        library
            .with(|conn| {
                conn.execute("UPDATE books SET progress = 0.25, favorite = 1 WHERE id = 'v1'", [])?;
                Ok(())
            })
            .expect("progress");

        let moved = migrate(&library, "v1", "v2").expect("migrate");
        assert_eq!(moved.annotations, 1, "{moved:?}");
        assert_eq!(moved.unlocated, 0, "{moved:?}");
        assert_eq!(moved.bookmarks, 1, "{moved:?}");
        assert!(moved.progress, "{moved:?}");

        // The highlight sits in the new edition at the text it covers, and
        // keeps its ink, its style and its note.
        let placed = library.with(|conn| annotations::list(conn, "v2")).expect("list");
        assert_eq!(placed.len(), 1, "{placed:?}");
        assert_eq!(placed[0].chapter_idx, 0);
        assert_eq!(&placed[0].text, "他推开 门");
        assert_eq!(placed[0].color.as_deref(), Some("#ffd12e"));
        assert_eq!(placed[0].style.as_deref(), Some("underline"));
        assert_eq!(placed[0].note.as_deref(), Some("开场"));
        // A CFI would point into the old file; it must not travel.
        assert!(placed[0].cfi.is_none());

        // The old edition still has its own copy — deleting it is the caller's
        // step, so a failure above cannot cost the reader the book.
        assert_eq!(library.with(|conn| annotations::list(conn, "v1")).expect("list").len(), 1);
        let favorite: i64 = library
            .with(|conn| {
                Ok(conn.query_row("SELECT favorite FROM books WHERE id = 'v2'", [], |r| r.get(0))?)
            })
            .expect("favorite");
        assert_eq!(favorite, 1, "收藏也要跟着走");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_paragraph_that_was_rewritten_is_reported_not_dropped() {
        let (dir, library) = library("migrate-lost");
        book(&library, "v1", "书", &["原来的这句话。"]);
        book(&library, "v2", "书", &["改成了完全不同的话。"]);
        library
            .with(|conn| annotations::create(conn, "v1", 0, 0, 6, "原来的这句话", None, None, None))
            .expect("annotate");

        let moved = migrate(&library, "v1", "v2").expect("migrate");
        assert_eq!(moved.annotations, 0);
        assert_eq!(moved.unlocated, 1, "新版本里没有这句原文，必须报出来");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrating_a_book_onto_itself_is_refused() {
        let (dir, library) = library("migrate-self");
        book(&library, "v1", "书", &["正文。"]);
        assert!(migrate(&library, "v1", "v1").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_run_does_not_duplicate_anything() {
        let (dir, library) = library("migrate-twice");
        book(&library, "v1", "书", &["同一句话。"]);
        book(&library, "v2", "书", &["同一句话。"]);
        library
            .with(|conn| annotations::create(conn, "v1", 0, 0, 5, "同一句话", None, None, None))
            .expect("annotate");

        assert_eq!(migrate(&library, "v1", "v2").expect("first").annotations, 1);
        assert_eq!(migrate(&library, "v1", "v2").expect("second").annotations, 0);
        assert_eq!(library.with(|conn| annotations::list(conn, "v2")).expect("list").len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
