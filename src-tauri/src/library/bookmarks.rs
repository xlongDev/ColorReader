//! Bookmark persistence: named pins into a book's reading flow.
//!
//! A bookmark stores a chapter index plus the scroll fraction inside that
//! chapter, which is all the reader needs to jump back. `label` is the list
//! snippet the frontend shows, typically the chapter title and position.

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// A bookmark as the UI sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub chapter_idx: usize,
    pub fraction: f64,
    pub label: String,
    pub created_at: i64,
}

/// Inserts one bookmark, returning it with its generated id.
///
/// `label` is trimmed and must not be empty; `fraction` is clamped into 0..1.
pub fn create(
    conn: &Connection,
    book_id: &str,
    chapter_idx: usize,
    fraction: f64,
    label: &str,
) -> AppResult<Bookmark> {
    let label = label.trim();
    if label.is_empty() {
        return Err(AppError::InvalidArgument("书签名称不能为空".into()));
    }

    let bookmark = Bookmark {
        id: uuid::Uuid::new_v4().to_string(),
        book_id: book_id.to_string(),
        chapter_idx,
        fraction: fraction.clamp(0.0, 1.0),
        label: label.to_string(),
        created_at: super::now_seconds(),
    };
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, chapter_idx, fraction, label, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            bookmark.id,
            bookmark.book_id,
            bookmark.chapter_idx as i64,
            bookmark.fraction,
            bookmark.label,
            bookmark.created_at,
        ],
    )?;
    Ok(bookmark)
}

/// Every bookmark for a book, in reading order.
pub fn list(conn: &Connection, book_id: &str) -> AppResult<Vec<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_idx, fraction, label, created_at \
         FROM bookmarks WHERE book_id = ?1 ORDER BY chapter_idx, fraction, created_at",
    )?;
    let mut rows = stmt.query(params![book_id])?;
    let mut bookmarks = Vec::new();
    while let Some(row) = rows.next()? {
        bookmarks.push(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_idx: row.get::<_, i64>(2)? as usize,
            fraction: row.get(3)?,
            label: row.get(4)?,
            created_at: row.get(5)?,
        });
    }
    Ok(bookmarks)
}

/// Deletes one bookmark; `NotFound` when it does not exist.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let changed = conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
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
    fn bookmarks_round_trip_and_list_in_reading_order() {
        let conn = seed();
        create(&conn, "b", 3, 0.8, "later").expect("create");
        let first = create(&conn, "b", 0, 1.5, " start ").expect("create");

        assert_eq!(first.label, "start", "名称要裁剪首尾空白");
        assert_eq!(first.fraction, 1.0, "fraction 必须被收进 0..1");

        let all = list(&conn, "b").expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].chapter_idx, 0);
        assert_eq!(all[1].chapter_idx, 3, "按章节与位置排序");
    }

    #[test]
    fn empty_label_is_rejected() {
        let conn = seed();
        assert!(matches!(create(&conn, "b", 0, 0.0, "   "), Err(AppError::InvalidArgument(_))));
    }

    #[test]
    fn deleting_an_unknown_id_is_not_found() {
        let conn = seed();
        assert!(matches!(delete(&conn, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn deleting_a_book_cascades_to_its_bookmarks() {
        let conn = seed();
        create(&conn, "b", 0, 0.0, "pin").expect("create");
        conn.execute("DELETE FROM books WHERE id = 'b'", []).expect("delete book");
        assert!(list(&conn, "b").expect("list").is_empty(), "外键级联必须清空书签");
    }
}
