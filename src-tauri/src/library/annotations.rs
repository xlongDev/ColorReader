//! Annotation persistence: highlights anchored to immutable chapter text.
//!
//! A highlight is a character range into one chapter plus the text it covers.
//! Offsets are UTF-16 code-unit counts computed and interpreted only by the
//! frontend; the backend stores them opaquely and keeps `text` as the snippet
//! shown in the list. Chapter content never changes for a given book (re-import
//! is a new content hash), so nothing re-locates stale offsets.

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// A highlight as the UI sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub book_id: String,
    pub chapter_idx: usize,
    pub start_char: usize,
    pub end_char: usize,
    pub text: String,
    /// Opaque re-anchoring key for foliate-rendered books (a CFI). `None` for
    /// every format the (chapter, offset) pair already locates.
    pub cfi: Option<String>,
    pub created_at: i64,
}

/// Validates and inserts one highlight, returning it with its generated id.
///
/// `text` is trimmed and must not be empty; the range must be non-empty.
/// `cfi` carries the foliate anchor of a Kindle highlight; it is stored
/// verbatim and never interpreted here.
pub fn create(
    conn: &Connection,
    book_id: &str,
    chapter_idx: usize,
    start_char: usize,
    end_char: usize,
    text: &str,
    cfi: Option<&str>,
) -> AppResult<Annotation> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::InvalidArgument("高亮内容不能为空".into()));
    }
    if start_char >= end_char {
        return Err(AppError::InvalidArgument("高亮范围无效".into()));
    }

    let annotation = Annotation {
        id: uuid::Uuid::new_v4().to_string(),
        book_id: book_id.to_string(),
        chapter_idx,
        start_char,
        end_char,
        text: text.to_string(),
        cfi: cfi.map(str::to_string),
        created_at: super::now_seconds(),
    };
    conn.execute(
        "INSERT INTO annotations \
         (id, book_id, chapter_idx, start_char, end_char, text, cfi, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            annotation.id,
            annotation.book_id,
            annotation.chapter_idx as i64,
            annotation.start_char as i64,
            annotation.end_char as i64,
            annotation.text,
            annotation.cfi,
            annotation.created_at,
        ],
    )?;
    Ok(annotation)
}

/// Every highlight for a book, ordered by chapter then position.
pub fn list(conn: &Connection, book_id: &str) -> AppResult<Vec<Annotation>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_idx, start_char, end_char, text, cfi, created_at \
         FROM annotations WHERE book_id = ?1 ORDER BY chapter_idx, start_char",
    )?;
    let mut rows = stmt.query(params![book_id])?;
    let mut annotations = Vec::new();
    while let Some(row) = rows.next()? {
        annotations.push(Annotation {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_idx: row.get::<_, i64>(2)? as usize,
            start_char: row.get::<_, i64>(3)? as usize,
            end_char: row.get::<_, i64>(4)? as usize,
            text: row.get(5)?,
            cfi: row.get(6)?,
            created_at: row.get(7)?,
        });
    }
    Ok(annotations)
}

/// Deletes one highlight; `NotFound` when it does not exist.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let changed = conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'txt', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn
    }

    #[test]
    fn highlights_round_trip_and_list_in_reading_order() {
        let conn = seed();
        let second = create(&conn, "b", 1, 2, 6, "later", None).expect("create");
        let first = create(&conn, "b", 0, 0, 4, " start ", None).expect("create");

        assert_eq!(first.text, "start", "文本要裁剪首尾空白");
        assert_ne!(first.id, second.id);
        assert_eq!(first.cfi, None);

        let all = list(&conn, "b").expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].chapter_idx, 0);
        assert_eq!(all[1].chapter_idx, 1, "按章节与位置排序");
    }

    #[test]
    fn empty_text_or_range_is_rejected() {
        let conn = seed();
        assert!(matches!(
            create(&conn, "b", 0, 0, 1, "   ", None),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            create(&conn, "b", 0, 3, 3, "x", None),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn cfi_is_stored_and_read_back() {
        let conn = seed();
        let cfi = "epubcfi(/6/4!/4/2/2:3)";
        create(&conn, "b", 0, 3, 9, "quoted", Some(cfi)).expect("create");
        let all = list(&conn, "b").expect("list");
        assert_eq!(all[0].cfi.as_deref(), Some(cfi), "CFI 要原样持久化");
    }

    #[test]
    fn deleting_an_unknown_id_is_not_found() {
        let conn = seed();
        assert!(matches!(delete(&conn, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn deleting_a_book_cascades_to_its_highlights() {
        let conn = seed();
        create(&conn, "b", 0, 0, 2, "hi", None).expect("create");
        conn.execute("DELETE FROM books WHERE id = 'b'", []).expect("delete book");
        assert!(list(&conn, "b").expect("list").is_empty(), "外键级联必须清空高亮");
    }
}
