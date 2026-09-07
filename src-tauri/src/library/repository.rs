//! Book persistence: queries and mutations for the library shelf.
//!
//! Authors and tags live in their own tables because the UI filters and sorts
//! on them; they are fetched with one grouped query per list rather than one
//! query per book.

use std::path::PathBuf;

use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};

#[cfg(test)]
use std::path::Path;

use super::sort_key;
use crate::document::BookFormat;
use crate::error::{AppError, AppResult};

/// Everything needed to insert a book that has just been imported.
pub struct NewBook<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub subtitle: Option<&'a str>,
    pub description: Option<&'a str>,
    pub language: Option<&'a str>,
    pub publisher: Option<&'a str>,
    pub identifier: Option<&'a str>,
    pub format: BookFormat,
    pub content_hash: &'a str,
    pub file_path: &'a str,
    pub file_size: i64,
    pub cover_path: Option<&'a str>,
    pub authors: &'a [String],
}

/// A book as the UI sees it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookSummary {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub format: BookFormat,
    pub file_size: i64,
    /// URL on the custom resource protocol, or `null` when there is no cover.
    pub cover_url: Option<String>,
    /// Unix seconds.
    pub added_at: i64,
    pub updated_at: i64,
    pub last_read_at: Option<i64>,
    /// 0..1.
    pub progress: f64,
    pub favorite: bool,
    pub authors: Vec<String>,
    pub tags: Vec<String>,
}

/// Which shelf the user is looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryFilter {
    #[default]
    All,
    Recent,
    Favorites,
}

impl LibraryFilter {
    fn predicate(self) -> Option<&'static str> {
        match self {
            LibraryFilter::All => None,
            LibraryFilter::Recent => Some("b.last_read_at IS NOT NULL"),
            LibraryFilter::Favorites => Some("b.favorite = 1"),
        }
    }
}

/// Sort orders exposed by the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibrarySort {
    #[default]
    RecentlyAdded,
    RecentlyRead,
    TitleAsc,
    AuthorAsc,
    OldestAdded,
}

impl LibrarySort {
    /// `ORDER BY` clause. Whitelisted because user input must never reach SQL
    /// as a fragment.
    fn order_by(self) -> &'static str {
        match self {
            LibrarySort::RecentlyAdded => "b.added_at DESC, b.sort_title ASC",
            LibrarySort::RecentlyRead => "b.last_read_at DESC, b.added_at DESC, b.sort_title ASC",
            LibrarySort::TitleAsc => "b.sort_title COLLATE NOCASE ASC",
            LibrarySort::AuthorAsc => {
                "(SELECT a.sort_name FROM book_authors ba
                    JOIN authors a ON a.id = ba.author_id
                   WHERE ba.book_id = b.id
                   ORDER BY ba.position LIMIT 1) COLLATE NOCASE ASC, b.sort_title ASC"
            }
            LibrarySort::OldestAdded => "b.added_at ASC, b.sort_title ASC",
        }
    }
}

/// Parsed list request coming from the frontend.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookQuery {
    #[serde(default)]
    pub filter: LibraryFilter,
    #[serde(default)]
    pub sort: LibrarySort,
    /// Case-insensitive substring matched against title and author names.
    #[serde(default)]
    pub search: Option<String>,
}

/// Aggregate counts shown above the shelf.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total: i64,
    pub favorites: i64,
    /// Started but not finished: has a read timestamp and is below 100%.
    pub reading: i64,
    pub finished: i64,
}

pub fn stats(conn: &Connection) -> AppResult<LibraryStats> {
    let (total, favorites, reading, finished) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(favorite), 0),
                COALESCE(SUM(last_read_at IS NOT NULL AND progress < 0.999), 0),
                COALESCE(SUM(progress >= 0.999), 0)
           FROM books",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(LibraryStats { total, favorites, reading, finished })
}

/// Absolute cover path for `id`, or `None` when the book has no cover.
pub fn cover_path(conn: &Connection, id: &str) -> AppResult<Option<PathBuf>> {
    let found = conn
        .query_row("SELECT cover_path FROM books WHERE id = ?1", params![id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten();
    Ok(found.map(PathBuf::from))
}

const SELECT_COLUMNS: &str = "b.id, b.title, b.subtitle, b.description, b.language, b.publisher, \
     b.format, b.file_size, b.cover_path, b.added_at, b.updated_at, b.last_read_at, b.progress, \
     b.favorite";

/// Loads the shelf for the given query.
pub fn list(conn: &Connection, query: &BookQuery) -> AppResult<Vec<BookSummary>> {
    let mut sql = format!("SELECT {SELECT_COLUMNS} FROM books b");
    let mut conditions: Vec<&str> = Vec::new();
    if let Some(predicate) = query.filter.predicate() {
        conditions.push(predicate);
    }
    let needle = normalized_search(&query.search);
    if needle.is_some() {
        conditions.push(
            "(b.title LIKE :needle ESCAPE '\\' OR b.sort_title LIKE :needle ESCAPE '\\' OR EXISTS (\
               SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id \
                WHERE ba.book_id = b.id AND a.name LIKE :needle ESCAPE '\\'))",
        );
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY ");
    sql.push_str(query.sort.order_by());

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = if let Some(needle) = needle.as_deref() {
        stmt.query(rusqlite::named_params! { ":needle": needle })?
    } else {
        stmt.query([])?
    };

    let mut books = Vec::new();
    while let Some(row) = rows.next()? {
        books.push(summary_from_row(row)?);
    }
    drop(rows);

    attach_authors(conn, &mut books)?;
    attach_tags(conn, &mut books)?;
    Ok(books)
}

/// A single book by id, for the reader header. `None` when unknown.
pub fn get(conn: &Connection, id: &str) -> AppResult<Option<BookSummary>> {
    let mut stmt =
        conn.prepare(&format!("SELECT {SELECT_COLUMNS} FROM books b WHERE b.id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    let mut book = summary_from_row(row)?;
    drop(rows);

    attach_authors(conn, std::slice::from_mut(&mut book))?;
    attach_tags(conn, std::slice::from_mut(&mut book))?;
    Ok(Some(book))
}

/// Maps a result row onto a `BookSummary` with empty authors/tags; callers
/// attach them afterwards with one grouped query.
fn summary_from_row(row: &rusqlite::Row<'_>) -> AppResult<BookSummary> {
    let id: String = row.get("id")?;
    let has_cover = row.get::<_, Option<String>>("cover_path")?.is_some();
    let cover_url = has_cover.then(|| super::cover_url(&id));
    Ok(BookSummary {
        id,
        title: row.get("title")?,
        subtitle: row.get("subtitle")?,
        description: row.get("description")?,
        language: row.get("language")?,
        publisher: row.get("publisher")?,
        format: parse_format(&row.get::<_, String>("format")?)?,
        file_size: row.get("file_size")?,
        cover_url,
        added_at: row.get("added_at")?,
        updated_at: row.get("updated_at")?,
        last_read_at: row.get("last_read_at")?,
        progress: row.get("progress")?,
        favorite: row.get::<_, i64>("favorite")? != 0,
        authors: Vec::new(),
        tags: Vec::new(),
    })
}

/// Wraps the search term in `%` and escapes LIKE wildcards.
fn normalized_search(search: &Option<String>) -> Option<String> {
    let trimmed = search.as_deref()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(like_pattern(trimmed))
}

/// Escapes LIKE wildcards and wraps `term` in `%`, for a substring match.
pub fn like_pattern(term: &str) -> String {
    let escaped = term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

/// Books whose chapters have not been extracted yet, oldest first.
///
/// Books imported before the reader engine existed only get chapters when they
/// are first opened, so a library-wide search has to back-fill them before it
/// can see their text.
pub fn books_without_chapters(conn: &Connection, book_id: Option<&str>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT b.id FROM books b
          WHERE NOT EXISTS (SELECT 1 FROM chapters c WHERE c.book_id = b.id)
            AND (?1 IS NULL OR b.id = ?1)
          ORDER BY b.added_at, b.id",
    )?;
    let rows = stmt.query_map(params![book_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn attach_authors(conn: &Connection, books: &mut [BookSummary]) -> AppResult<()> {
    let ids: Vec<&str> = books.iter().map(|book| book.id.as_str()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = placeholders(ids.len());
    let mut stmt = conn.prepare(&format!(
        "SELECT ba.book_id, a.name FROM book_authors ba
           JOIN authors a ON a.id = ba.author_id
          WHERE ba.book_id IN ({placeholders})
          ORDER BY ba.position"
    ))?;
    let mut rows = stmt.query(rusqlite::params_from_iter(ids))?;
    let mut by_book: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows.next()? {
        by_book.push((row.get(0)?, row.get(1)?));
    }
    for book in books.iter_mut() {
        book.authors =
            by_book.iter().filter(|(id, _)| id == &book.id).map(|(_, name)| name.clone()).collect();
    }
    Ok(())
}

fn attach_tags(conn: &Connection, books: &mut [BookSummary]) -> AppResult<()> {
    let ids: Vec<&str> = books.iter().map(|book| book.id.as_str()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = placeholders(ids.len());
    let mut stmt = conn.prepare(&format!(
        "SELECT bt.book_id, t.name FROM book_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE bt.book_id IN ({placeholders})
          ORDER BY t.name"
    ))?;
    let mut rows = stmt.query(rusqlite::params_from_iter(ids))?;
    let mut by_book: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows.next()? {
        by_book.push((row.get(0)?, row.get(1)?));
    }
    for book in books.iter_mut() {
        book.tags =
            by_book.iter().filter(|(id, _)| id == &book.id).map(|(_, name)| name.clone()).collect();
    }
    Ok(())
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count).collect::<Vec<_>>().join(", ")
}

/// Inserts a book plus its authors, reusing author rows when the name matches.
pub fn insert(tx: &Transaction<'_>, book: &NewBook<'_>) -> AppResult<()> {
    if book.title.trim().is_empty() {
        return Err(AppError::InvalidArgument("书名不能为空".into()));
    }
    tx.execute(
        "INSERT INTO books (id, title, sort_title, subtitle, description, language, publisher, \
         identifier, format, content_hash, file_path, file_size, cover_path, added_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            book.id,
            book.title,
            sort_key(book.title),
            book.subtitle,
            book.description,
            book.language,
            book.publisher,
            book.identifier,
            book.format.as_str(),
            book.content_hash,
            book.file_path,
            book.file_size,
            book.cover_path,
            super::now_seconds(),
            super::now_seconds(),
        ],
    )?;

    for (position, name) in book.authors.iter().enumerate() {
        let author_id = upsert_author(tx, name)?;
        tx.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES (?1, ?2, ?3)",
            params![book.id, author_id, position as i64],
        )?;
    }
    Ok(())
}

/// Returns the id of the author with this name, creating it when needed.
fn upsert_author(tx: &Transaction<'_>, name: &str) -> AppResult<String> {
    let existing: Option<String> = tx
        .query_row("SELECT id FROM authors WHERE name = ?1", params![name], |row| row.get(0))
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO authors (id, name, sort_name) VALUES (?1, ?2, ?3)",
        params![id, name, sort_key(name)],
    )?;
    Ok(id)
}

/// Files that must be removed from disk once a book row is gone.
#[derive(Debug, Default)]
pub struct DeletedFiles {
    pub book: Option<PathBuf>,
    pub cover: Option<PathBuf>,
}

/// Deletes a book and reports which files the caller should unlink.
///
/// Returns `NotFound` when the id does not exist so the UI can say so.
pub fn delete(conn: &Connection, id: &str) -> AppResult<DeletedFiles> {
    let (book_path, cover_path): (String, Option<String>) = conn
        .query_row("SELECT file_path, cover_path FROM books WHERE id = ?1", params![id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|_| AppError::NotFound(id.to_string()))?;

    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;

    Ok(DeletedFiles { book: Some(PathBuf::from(book_path)), cover: cover_path.map(PathBuf::from) })
}

/// Returns the id of the book holding this content hash, if any.
pub fn find_by_hash(conn: &Connection, hash: &str) -> AppResult<Option<(String, String)>> {
    let found = conn
        .query_row("SELECT id, title FROM books WHERE content_hash = ?1", params![hash], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok();
    Ok(found)
}

pub fn set_favorite(conn: &Connection, id: &str, favorite: bool) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE books SET favorite = ?1, updated_at = ?2 WHERE id = ?3",
        params![i64::from(favorite), super::now_seconds(), id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

/// Points a book at an already-written cover file, after import.
pub fn set_cover(conn: &Connection, id: &str, cover_path: &str) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE books SET cover_path = ?1, updated_at = ?2 WHERE id = ?3",
        params![cover_path, super::now_seconds(), id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

/// Records a reading position, clamped to `0..=1`, and bumps `last_read_at`.
pub fn set_progress(conn: &Connection, id: &str, progress: f64) -> AppResult<()> {
    let progress = progress.clamp(0.0, 1.0);
    let changed = conn.execute(
        "UPDATE books SET progress = ?1, last_read_at = ?2, updated_at = ?2 WHERE id = ?3",
        params![progress, super::now_seconds(), id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

/// The stored source file and its format, used to build chapters on demand for
/// books imported before the reader engine existed.
pub fn source(conn: &Connection, id: &str) -> AppResult<(String, BookFormat)> {
    let (path, format) = conn
        .query_row("SELECT file_path, format FROM books WHERE id = ?1", params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| AppError::NotFound(id.to_string()))?;
    Ok((path, parse_format(&format)?))
}

fn parse_format(value: &str) -> AppResult<BookFormat> {
    match value {
        "epub" => Ok(BookFormat::Epub),
        "pdf" => Ok(BookFormat::Pdf),
        "mobi" => Ok(BookFormat::Mobi),
        "fb2" => Ok(BookFormat::Fb2),
        "cbz" => Ok(BookFormat::Cbz),
        "markdown" => Ok(BookFormat::Markdown),
        "txt" => Ok(BookFormat::Text),
        other => Err(AppError::UnsupportedFormat(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::document::RawChapter;
    use crate::library::chapters;

    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn
    }

    fn add(conn: &Connection, id: &str, title: &str, authors: &[&str], hash: &str) {
        let owned: Vec<String> = authors.iter().map(|a| a.to_string()).collect();
        let tx = conn.unchecked_transaction().expect("tx");
        insert(
            &tx,
            &NewBook {
                id,
                title,
                subtitle: None,
                description: None,
                language: Some("zh"),
                publisher: None,
                identifier: None,
                format: BookFormat::Epub,
                content_hash: hash,
                file_path: &format!("/books/{id}.epub"),
                file_size: 1024,
                cover_path: None,
                authors: &owned,
            },
        )
        .expect("insert");
        tx.commit().expect("commit");
    }

    #[test]
    fn inserted_books_come_back_with_their_authors() {
        let conn = seed();
        add(&conn, "b1", "三体", &["刘慈欣"], "h1");
        add(&conn, "b2", "球状闪电", &["刘慈欣", "某人"], "h2");

        let books = list(&conn, &BookQuery::default()).expect("list");
        assert_eq!(books.len(), 2);
        let first = books.iter().find(|b| b.id == "b2").expect("b2");
        assert_eq!(first.authors, ["刘慈欣", "某人"], "作者顺序必须保留");
    }

    #[test]
    fn sort_keys_strip_leading_articles() {
        assert_eq!(sort_key("The Rust Book"), "rust book");
        assert_eq!(sort_key("An Introduction"), "introduction");
        assert_eq!(sort_key("三体"), "三体");
    }

    #[test]
    fn search_matches_titles_and_authors() {
        let conn = seed();
        add(&conn, "b1", "三体", &["刘慈欣"], "h1");
        add(&conn, "b2", "Dune", &["Frank Herbert"], "h2");

        let by_title =
            list(&conn, &BookQuery { search: Some("dune".into()), ..Default::default() })
                .expect("list");
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].id, "b2");

        let by_author =
            list(&conn, &BookQuery { search: Some("刘慈欣".into()), ..Default::default() })
                .expect("list");
        assert_eq!(by_author.len(), 1);
        assert_eq!(by_author[0].id, "b1");
    }

    #[test]
    fn like_wildcards_in_the_search_box_are_escaped() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");

        // A bare `%` must not collapse to "match everything".
        let all = list(&conn, &BookQuery { search: Some("%".into()), ..Default::default() })
            .expect("list");
        assert_eq!(all.len(), 0, "% 必须被转义而不是当通配符");
    }

    #[test]
    fn author_sort_orders_by_the_first_author() {
        let conn = seed();
        add(&conn, "b1", "Zed", &["Zoe"], "h1");
        add(&conn, "b2", "Alpha", &["Adam"], "h2");

        let books = list(&conn, &BookQuery { sort: LibrarySort::AuthorAsc, ..Default::default() })
            .expect("list");
        assert_eq!(books[0].id, "b2");
    }

    #[test]
    fn favorites_and_recent_filters_narrow_the_shelf() {
        let conn = seed();
        add(&conn, "b1", "未读", &[], "h1");
        add(&conn, "b2", "在读", &[], "h2");
        set_favorite(&conn, "b2", true).expect("favorite");
        conn.execute("UPDATE books SET last_read_at = 500 WHERE id = 'b2'", []).expect("touch");

        let favorites =
            list(&conn, &BookQuery { filter: LibraryFilter::Favorites, ..Default::default() })
                .expect("list");
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0].id, "b2");

        let recent =
            list(&conn, &BookQuery { filter: LibraryFilter::Recent, ..Default::default() })
                .expect("list");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "b2");
    }

    #[test]
    fn deleting_removes_the_row_and_reports_its_files() {
        let conn = seed();
        add(&conn, "b1", "三体", &["刘慈欣"], "h1");

        let deleted = delete(&conn, "b1").expect("delete");
        assert_eq!(deleted.book.as_deref(), Some(Path::new("/books/b1.epub")));
        assert!(find_by_hash(&conn, "h1").expect("query").is_none());
    }

    #[test]
    fn deleting_an_unknown_id_is_not_found() {
        let conn = seed();
        assert!(matches!(delete(&conn, "nope"), Err(AppError::NotFound(_))));
        assert!(matches!(set_favorite(&conn, "nope", true), Err(AppError::NotFound(_))));
    }

    #[test]
    fn stats_count_the_shelf_by_state() {
        let conn = seed();
        assert_eq!(stats(&conn).expect("stats"), LibraryStats::default());

        add(&conn, "b1", "未读", &[], "h1");
        add(&conn, "b2", "在读", &[], "h2");
        add(&conn, "b3", "读完", &[], "h3");
        set_favorite(&conn, "b1", true).expect("favorite");
        conn.execute("UPDATE books SET last_read_at = 1, progress = 0.4 WHERE id = 'b2'", [])
            .expect("touch");
        conn.execute("UPDATE books SET last_read_at = 2, progress = 1.0 WHERE id = 'b3'", [])
            .expect("touch");

        assert_eq!(
            stats(&conn).expect("stats"),
            LibraryStats { total: 3, favorites: 1, reading: 1, finished: 1 }
        );
    }

    #[test]
    fn books_without_chapters_are_listed_until_they_are_extracted() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");
        add(&conn, "b2", "Dune", &[], "h2");
        assert_eq!(books_without_chapters(&conn, None).expect("query"), ["b1", "b2"]);

        let tx = conn.unchecked_transaction().expect("tx");
        chapters::insert(&tx, "b1", &[RawChapter { title: None, paragraphs: vec!["正文".into()] }])
            .expect("insert chapters");
        tx.commit().expect("commit");

        assert_eq!(books_without_chapters(&conn, None).expect("query"), ["b2"]);
        assert!(books_without_chapters(&conn, Some("b1")).expect("query").is_empty());
    }

    #[test]
    fn cover_path_is_none_for_books_without_a_cover() {
        let conn = seed();
        add(&conn, "b1", "无封面", &[], "h1");
        assert_eq!(cover_path(&conn, "b1").expect("query"), None);
        assert_eq!(cover_path(&conn, "missing").expect("query"), None);
    }

    #[test]
    fn duplicate_hashes_are_rejected_by_the_database() {
        let conn = seed();
        add(&conn, "b1", "第一本", &[], "same");
        assert!(add_tx(&conn, "b2", "第二本", "same").is_err());
    }

    fn add_tx(conn: &Connection, id: &str, title: &str, hash: &str) -> AppResult<()> {
        let tx = conn.unchecked_transaction()?;
        insert(
            &tx,
            &NewBook {
                id,
                title,
                subtitle: None,
                description: None,
                language: None,
                publisher: None,
                identifier: None,
                format: BookFormat::Epub,
                content_hash: hash,
                file_path: "p",
                file_size: 1,
                cover_path: None,
                authors: &[],
            },
        )?;
        tx.commit()?;
        Ok(())
    }
}
