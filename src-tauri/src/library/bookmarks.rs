//! Bookmark persistence: named pins into a book's reading flow.
//!
//! A bookmark stores a chapter index plus the scroll fraction inside that
//! chapter, which is all the reader needs to jump back. `label` is the list
//! snippet the frontend shows, typically the chapter title and position.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

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
        "INSERT INTO bookmarks (id, book_id, chapter_idx, fraction, label, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
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
///
/// Same shape as deleting a highlight: the row goes for real so every local
/// query stays filter-free, and a tombstone is left so the deletion reaches the
/// other devices instead of being pulled back on the next sync.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    tx.execute(
        "INSERT INTO bookmark_tombstones (id, updated_at) VALUES (?1, ?2) \
         ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at",
        params![id, super::now_seconds()],
    )?;
    tx.commit()?;
    Ok(())
}

/// One bookmark as the sync layer moves it between devices. `book` is the
/// owning book's `content_hash`; `id` is the UUID the creating device minted,
/// carried verbatim everywhere so it stays a stable cross-device key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBookmark {
    pub id: String,
    #[serde(default)]
    pub book: String,
    pub chapter_idx: usize,
    pub fraction: f64,
    #[serde(default)]
    pub label: String,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

impl SyncBookmark {
    /// Everything a merge compares except the write clock.
    pub fn same_payload(&self, other: &Self) -> bool {
        self.id == other.id
            && self.book == other.book
            && self.chapter_idx == other.chapter_idx
            && self.fraction == other.fraction
            && self.label == other.label
            && self.deleted == other.deleted
    }
}

/// Every bookmark to sync — live rows and tombstones alike.
pub fn for_sync(conn: &Connection) -> AppResult<Vec<SyncBookmark>> {
    let mut stmt = conn.prepare(
        "SELECT k.id, b.content_hash, k.chapter_idx, k.fraction, k.label, k.updated_at \
         FROM bookmarks k JOIN books b ON b.id = k.book_id",
    )?;
    let live = stmt.query_map([], |row| {
        Ok(SyncBookmark {
            id: row.get(0)?,
            book: row.get(1)?,
            chapter_idx: row.get::<_, i64>(2)? as usize,
            fraction: row.get(3)?,
            label: row.get(4)?,
            updated_at: row.get(5)?,
            deleted: false,
        })
    })?;
    let mut out = live.collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare("SELECT id, updated_at FROM bookmark_tombstones")?;
    let graves = stmt.query_map([], |row| {
        Ok(SyncBookmark {
            id: row.get(0)?,
            book: String::new(),
            chapter_idx: 0,
            fraction: 0.0,
            label: String::new(),
            updated_at: row.get(1)?,
            deleted: true,
        })
    })?;
    out.extend(graves.collect::<rusqlite::Result<Vec<_>>>()?);
    Ok(out)
}

/// Writes a bookmark that won the merge; a no-op when the book is not imported.
pub fn apply_remote(conn: &Connection, remote: &SyncBookmark) -> AppResult<()> {
    let book_id: Option<String> = conn
        .query_row("SELECT id FROM books WHERE content_hash = ?1", params![remote.book], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(book_id) = book_id else { return Ok(()) };
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, chapter_idx, fraction, label, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT (id) DO UPDATE SET book_id = excluded.book_id, \
           chapter_idx = excluded.chapter_idx, fraction = excluded.fraction, \
           label = excluded.label, updated_at = excluded.updated_at",
        params![
            remote.id,
            book_id,
            remote.chapter_idx as i64,
            remote.fraction.clamp(0.0, 1.0),
            remote.label,
            super::now_seconds(),
            remote.updated_at,
        ],
    )?;
    Ok(())
}

/// Drops one bookmark without leaving a tombstone — the other device's delete
/// already is one.
pub fn remove(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
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

    #[test]
    fn create_stamps_the_write_clock() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0.2, "pin").expect("create");
        let stamp: i64 = conn
            .query_row("SELECT updated_at FROM bookmarks WHERE id = ?1", params![made.id], |row| {
                row.get(0)
            })
            .expect("updated_at");
        assert_eq!(stamp, made.created_at, "创建即写入 updated_at");
    }

    #[test]
    fn deleting_leaves_a_tombstone_that_sync_can_carry() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0.2, "pin").expect("create");
        delete(&conn, &made.id).expect("delete");

        assert!(list(&conn, "b").expect("list").is_empty(), "本地行必须真的没了");
        let grave = for_sync(&conn)
            .expect("for_sync")
            .into_iter()
            .find(|entry| entry.id == made.id)
            .expect("墓碑必须在同步列表里");
        assert!(grave.deleted);
        assert!(grave.updated_at > 0);
        assert!(grave.book.is_empty());
    }

    #[test]
    fn for_sync_identifies_the_owning_book_by_content_hash() {
        let conn = seed();
        create(&conn, "b", 0, 0.2, "pin").expect("create");
        let entry = &for_sync(&conn).expect("for_sync")[0];
        assert_eq!(entry.book, "h");
    }

    #[test]
    fn apply_remote_resolves_the_book_and_upserts_by_id() {
        let conn = seed();
        let remote = SyncBookmark {
            id: "from-other-device".into(),
            book: "h".into(),
            chapter_idx: 4,
            fraction: 0.35,
            label: "第 5 章".into(),
            updated_at: 500,
            deleted: false,
        };
        apply_remote(&conn, &remote).expect("apply");
        let all = list(&conn, "b").expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "from-other-device", "要保持对方的 id");
        assert_eq!(all[0].label, "第 5 章");

        apply_remote(&conn, &SyncBookmark { label: "改过".into(), ..remote.clone() })
            .expect("apply again");
        assert_eq!(list(&conn, "b").expect("list").len(), 1, "同一个 id 不能变成两行");
        assert_eq!(list(&conn, "b").expect("list")[0].label, "改过");

        // A fraction outside 0..1 would break the CHECK; clamp on the way in.
        apply_remote(&conn, &SyncBookmark { fraction: 9.0, ..remote.clone() }).expect("clamp");
        assert_eq!(list(&conn, "b").expect("list")[0].fraction, 1.0);

        apply_remote(&conn, &SyncBookmark { book: "not-here".into(), ..remote })
            .expect("未导入的书要静默跳过");
        assert_eq!(list(&conn, "b").expect("list").len(), 1);
    }

    #[test]
    fn remove_drops_the_row_without_leaving_a_tombstone() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0.2, "pin").expect("create");
        remove(&conn, &made.id).expect("remove");
        assert!(list(&conn, "b").expect("list").is_empty());
        assert!(
            for_sync(&conn).expect("for_sync").iter().all(|entry| !entry.deleted),
            "远端墓碑的本地应用不该再产出一个墓碑"
        );
    }
}
