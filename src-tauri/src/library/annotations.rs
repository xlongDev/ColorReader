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
    /// Highlight ink as a hex string (e.g. "#ffd12e"); `None` = legacy yellow.
    pub color: Option<String>,
    /// How the ink paints: "highlight" (translucent wash), "underline" or
    /// "squiggly"; `None` reads as "highlight".
    pub style: Option<String>,
    pub created_at: i64,
}

/// Allowed `style` values; anything else is rejected at the trust boundary.
const STYLES: [&str; 3] = ["highlight", "underline", "squiggly"];

fn validated_style(style: Option<&str>) -> AppResult<Option<String>> {
    match style {
        None => Ok(None),
        Some(value) if STYLES.contains(&value) => Ok(Some(value.to_string())),
        Some(other) => Err(AppError::InvalidArgument(format!("未知的标注样式: {other}"))),
    }
}

/// Validates and inserts one highlight, returning it with its generated id.
///
/// `text` is trimmed and must not be empty; the range must be non-empty.
/// `cfi` carries the foliate anchor of a Kindle highlight; it is stored
/// verbatim and never interpreted here. `color` is the frontend's hex string,
/// `style` one of `STYLES`; both optional and stored verbatim.
#[allow(clippy::too_many_arguments)]
pub fn create(
    conn: &Connection,
    book_id: &str,
    chapter_idx: usize,
    start_char: usize,
    end_char: usize,
    text: &str,
    cfi: Option<&str>,
    color: Option<&str>,
    style: Option<&str>,
) -> AppResult<Annotation> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::InvalidArgument("高亮内容不能为空".into()));
    }
    if start_char >= end_char {
        return Err(AppError::InvalidArgument("高亮范围无效".into()));
    }
    let style = validated_style(style)?;

    let annotation = Annotation {
        id: uuid::Uuid::new_v4().to_string(),
        book_id: book_id.to_string(),
        chapter_idx,
        start_char,
        end_char,
        text: text.to_string(),
        cfi: cfi.map(str::to_string),
        color: color.map(str::to_string),
        style,
        created_at: super::now_seconds(),
    };
    conn.execute(
        "INSERT INTO annotations \
         (id, book_id, chapter_idx, start_char, end_char, text, cfi, color, style, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            annotation.id,
            annotation.book_id,
            annotation.chapter_idx as i64,
            annotation.start_char as i64,
            annotation.end_char as i64,
            annotation.text,
            annotation.cfi,
            annotation.color,
            annotation.style,
            annotation.created_at,
        ],
    )?;
    Ok(annotation)
}

/// Restyles one highlight (the toolbar's re-colour / re-shape path). Only the
/// fields that are `Some` change; the row is read back so the cache updates
/// from the database's own answer.
pub fn update(
    conn: &Connection,
    id: &str,
    color: Option<&str>,
    style: Option<&str>,
) -> AppResult<Annotation> {
    let style = validated_style(style)?;
    let changed = conn.execute(
        "UPDATE annotations SET \
         color = COALESCE(?2, color), style = COALESCE(?3, style) WHERE id = ?1",
        params![id, color, style],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    read(conn, id)
}

/// Sets the foliate anchor of an imported highlight.
///
/// A clipping from `My Clippings.txt` arrives as text alone, so its row is
/// written without a CFI and the reader — the only party that has the book
/// loaded — calls this once it has located that text in a section. Deliberately
/// not folded into [`update`], which owns the ink: sharing one `UPDATE` would
/// let a re-colour blank the anchor, or an anchor blank the colour.
pub fn anchor(conn: &Connection, id: &str, cfi: &str) -> AppResult<Annotation> {
    if cfi.trim().is_empty() {
        return Err(AppError::InvalidArgument("标注锚点不能为空".into()));
    }
    let changed =
        conn.execute("UPDATE annotations SET cfi = ?2 WHERE id = ?1", params![id, cfi.trim()])?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    read(conn, id)
}

/// The annotation columns, in the order [`from_row`] reads them.
const COLUMNS: &str = "id, book_id, chapter_idx, start_char, end_char, text, cfi, color, style, \
                       created_at";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        book_id: row.get(1)?,
        chapter_idx: row.get::<_, i64>(2)? as usize,
        start_char: row.get::<_, i64>(3)? as usize,
        end_char: row.get::<_, i64>(4)? as usize,
        text: row.get(5)?,
        cfi: row.get(6)?,
        color: row.get(7)?,
        style: row.get(8)?,
        created_at: row.get(9)?,
    })
}

/// One annotation by id, as the database holds it.
fn read(conn: &Connection, id: &str) -> AppResult<Annotation> {
    let sql = format!("SELECT {COLUMNS} FROM annotations WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row).map_err(|_| AppError::NotFound(id.to_string()))
}

/// Every highlight for a book, ordered by chapter then position.
pub fn list(conn: &Connection, book_id: &str) -> AppResult<Vec<Annotation>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM annotations WHERE book_id = ?1 ORDER BY chapter_idx, start_char"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![book_id], from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
        let second = create(&conn, "b", 1, 2, 6, "later", None, None, None).expect("create");
        let first = create(&conn, "b", 0, 0, 4, " start ", None, None, None).expect("create");

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
            create(&conn, "b", 0, 0, 1, "   ", None, None, None),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            create(&conn, "b", 0, 3, 3, "x", None, None, None),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn cfi_is_stored_and_read_back() {
        let conn = seed();
        let cfi = "epubcfi(/6/4!/4/2/2:3)";
        create(&conn, "b", 0, 3, 9, "quoted", Some(cfi), None, None).expect("create");
        let all = list(&conn, "b").expect("list");
        assert_eq!(all[0].cfi.as_deref(), Some(cfi), "CFI 要原样持久化");
    }

    #[test]
    fn deleting_an_unknown_id_is_not_found() {
        let conn = seed();
        assert!(matches!(delete(&conn, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn update_restyles_partially_and_validates() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        let styled = update(&conn, &made.id, Some("#7cd92c"), Some("squiggly")).expect("update");
        assert_eq!(styled.color.as_deref(), Some("#7cd92c"));
        assert_eq!(styled.style.as_deref(), Some("squiggly"));
        // Partial: a colour-only update keeps the previous style.
        let recolored = update(&conn, &made.id, Some("#ffd12e"), None).expect("update");
        assert_eq!(recolored.style.as_deref(), Some("squiggly"));
        assert!(matches!(
            update(&conn, &made.id, None, Some("bold")),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(update(&conn, "nope", Some("#fff"), None), Err(AppError::NotFound(_))));
    }

    #[test]
    fn anchoring_an_imported_highlight_leaves_its_ink_alone() {
        let conn = seed();
        // An imported clipping: text, no CFI, and the reader has since coloured it.
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        update(&conn, &made.id, Some("#7cd92c"), Some("underline")).expect("update");

        let cfi = "epubcfi(/6/4!/4/2/2:3)";
        let anchored = anchor(&conn, &made.id, cfi).expect("anchor");
        assert_eq!(anchored.cfi.as_deref(), Some(cfi));
        assert_eq!(anchored.color.as_deref(), Some("#7cd92c"), "写锚点不能抹掉颜色");
        assert_eq!(anchored.style.as_deref(), Some("underline"), "写锚点不能抹掉样式");

        // And the other way round: a re-colour keeps the anchor.
        let restyled = update(&conn, &made.id, Some("#ffd12e"), None).expect("update");
        assert_eq!(restyled.cfi.as_deref(), Some(cfi), "改样式不能抹掉锚点");
    }

    #[test]
    fn anchoring_validates_its_input_and_reports_a_missing_row() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        assert!(matches!(anchor(&conn, &made.id, "  "), Err(AppError::InvalidArgument(_))));
        assert!(matches!(anchor(&conn, "nope", "epubcfi(/6/4)"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn deleting_a_book_cascades_to_its_highlights() {
        let conn = seed();
        create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        conn.execute("DELETE FROM books WHERE id = 'b'", []).expect("delete book");
        assert!(list(&conn, "b").expect("list").is_empty(), "外键级联必须清空高亮");
    }
}
