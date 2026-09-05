//! Full-text search over chapter bodies.
//!
//! The index is an FTS5 external content table over `chapters`, so the text
//! lives once on disk and the triggers in migration v4 keep the index in step
//! with the table. Ranking is BM25, which SQLite computes from the index.
//!
//! A hit carries the character offset of the match inside the chapter so the
//! reader can scroll straight to the paragraph holding it.

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::AppResult;
use crate::library::repository;

/// Shortest query the trigram index accepts. Anything below this falls back to
/// `LIKE` (see [`like_matches`]).
const MIN_QUERY_CHARS: usize = 3;

/// Characters wrapping the matched run inside [`SearchHit::snippet`].
///
/// Control characters rather than markup: the frontend splits on them, and no
/// extracted book text is expected to contain them.
pub const MARK_START: char = '\u{2}';
pub const MARK_END: char = '\u{3}';

/// Characters kept on each side of a match when building a snippet.
const WINDOW_CHARS: usize = 40;

/// One place where the needle occurs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub book_id: String,
    pub book_title: String,
    pub chapter_idx: usize,
    pub chapter_title: String,
    /// Text around the match, with the match itself wrapped in `MARK_START`
    /// and `MARK_END`.
    pub snippet: String,
    /// Character offset of the match inside the chapter's joined text.
    pub offset: usize,
}

/// `(book_id, book_title, chapter_idx, chapter_title, content)`.
type Raw = (String, String, i64, String, String);

/// Chapters matching `needle`, best (lowest BM25 score) first.
///
/// Passing `book_id` restricts the search to one book.
pub fn query(
    conn: &Connection,
    needle: &str,
    book_id: Option<&str>,
    limit: usize,
) -> AppResult<Vec<SearchHit>> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let needle_lower = needle.to_lowercase();
    let needle_chars = needle.chars().count();

    let rows = if needle_chars >= MIN_QUERY_CHARS {
        fts_matches(conn, needle, book_id, limit)?
    } else {
        like_matches(conn, needle, book_id, limit)?
    };

    Ok(rows
        .into_iter()
        .map(|(book_id, book_title, chapter_idx, chapter_title, content)| {
            let offset = match_offset(&content, &needle_lower);
            SearchHit {
                book_id,
                book_title,
                chapter_idx: chapter_idx as usize,
                chapter_title,
                snippet: snippet(&content, offset, needle_chars),
                offset,
            }
        })
        .collect())
}

/// Index-backed lookup, ordered by BM25.
fn fts_matches(
    conn: &Connection,
    needle: &str,
    book_id: Option<&str>,
    limit: usize,
) -> AppResult<Vec<Raw>> {
    // Quoting the needle turns it into one literal phrase, so FTS5 operator
    // syntax (`OR`, `*`, unbalanced quotes) can never escape the search box.
    let phrase = format!("\"{}\"", needle.replace('"', "\"\""));
    let mut stmt = conn.prepare(
        "SELECT c.book_id, b.title, c.idx, c.title, c.content
           FROM chapters_fts
           JOIN chapters c ON c.rowid = chapters_fts.rowid
           JOIN books b ON b.id = c.book_id
          WHERE chapters_fts MATCH ?1 AND (?2 IS NULL OR c.book_id = ?2)
          ORDER BY bm25(chapters_fts)
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![phrase, book_id, limit as i64], row_to_raw)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Substring fallback for queries the trigram index rejects.
///
/// ponytail: `LIKE '%…%'` cannot use an index, so this scans every chapter of
/// every book. Fine at one or two characters typed by hand; if short queries
/// ever feel slow, gate them behind an explicit submit instead of live search.
fn like_matches(
    conn: &Connection,
    needle: &str,
    book_id: Option<&str>,
    limit: usize,
) -> AppResult<Vec<Raw>> {
    let pattern = repository::like_pattern(needle);
    let mut stmt = conn.prepare(
        "SELECT c.book_id, b.title, c.idx, c.title, c.content
           FROM chapters c
           JOIN books b ON b.id = c.book_id
          WHERE c.content LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR c.book_id = ?2)
          ORDER BY c.book_id, c.idx
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![pattern, book_id, limit as i64], row_to_raw)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn row_to_raw(row: &rusqlite::Row<'_>) -> rusqlite::Result<Raw> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
}

/// Character offset of the first occurrence of `needle_lower` (already folded).
///
/// Counted on the lower-cased text because FTS5 matches case-insensitively, so
/// the offset has to land where the index found the match, not where a
/// case-sensitive scan would.
fn match_offset(content: &str, needle_lower: &str) -> usize {
    let lower = content.to_lowercase();
    match lower.find(needle_lower) {
        Some(byte) => lower[..byte].chars().count(),
        None => 0,
    }
}

/// `WINDOW_CHARS` of context around `[offset, offset + needle_chars)`, with the
/// match itself marked.
fn snippet(content: &str, offset: usize, needle_chars: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    let end = (offset + needle_chars + WINDOW_CHARS).min(chars.len());
    let mut out = String::new();
    if offset > WINDOW_CHARS {
        out.push('…');
        out.extend(&chars[offset - WINDOW_CHARS..offset]);
    } else {
        out.extend(&chars[0..offset]);
    }
    out.push(MARK_START);
    out.extend(&chars[offset..(offset + needle_chars).min(chars.len())]);
    out.push(MARK_END);
    out.extend(&chars[(offset + needle_chars).min(chars.len())..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
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

    fn add_book(conn: &mut Connection, id: &str, title: &str, chapters: &[&[&str]]) {
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES (?1, ?2, 'x', 'txt', ?1, 'p', 1, 1, 1)",
            params![id, title],
        )
        .expect("insert book");
        let raw: Vec<RawChapter> = chapters
            .iter()
            .enumerate()
            .map(|(idx, paragraphs)| RawChapter {
                title: Some(format!("第 {} 章", idx + 1)),
                paragraphs: paragraphs.iter().map(|p| p.to_string()).collect(),
            })
            .collect();
        let tx = conn.transaction().expect("tx");
        crate::library::chapters::insert(&tx, id, &raw).expect("insert chapters");
        tx.commit().expect("commit");
    }

    fn hits(conn: &Connection, needle: &str, book_id: Option<&str>) -> Vec<SearchHit> {
        query(conn, needle, book_id, 20).expect("query")
    }

    #[test]
    fn chinese_substrings_match_inside_a_run_of_text() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "三体", &[&["你好世界啊，这是很长的一段中文正文。"]]);

        let found = hits(&conn, "世界", None);
        assert_eq!(found.len(), 1, "unicode61 做不到的事，trigram 必须做到");
        assert_eq!(found[0].chapter_idx, 0);
        assert_eq!(found[0].book_title, "三体");
    }

    #[test]
    fn english_matches_are_case_insensitive() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "Dune", &[&["The spice must flow, they said."]]);

        let found = hits(&conn, "SPICE", None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].offset, 4, "偏移要指向匹配开始的位置");
    }

    #[test]
    fn one_hit_is_returned_per_matching_chapter() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["重复出现的关键词"], &["无关内容"], &["另一个关键词"]]);

        assert_eq!(hits(&conn, "关键词", None).len(), 2);
    }

    #[test]
    fn a_book_id_scopes_the_search() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "第一本", &[&["共同的一句话"]]);
        add_book(&mut conn, "b2", "第二本", &[&["共同的一句话"]]);

        assert_eq!(hits(&conn, "共同", None).len(), 2);
        let scoped = hits(&conn, "共同", Some("b2"));
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].book_id, "b2");
    }

    #[test]
    fn queries_shorter_than_three_characters_fall_back_to_like() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["爱情不是答案"]]);

        assert_eq!(hits(&conn, "爱情", None).len(), 1, "两字查询要走 LIKE 兜底");
        assert_eq!(hits(&conn, "爱", None).len(), 1);
    }

    #[test]
    fn blank_queries_return_nothing() {
        let conn = seed();
        assert!(hits(&conn, "", None).is_empty());
        assert!(hits(&conn, "   ", None).is_empty());
    }

    #[test]
    fn fts_operator_syntax_is_treated_as_literal_text() {
        let mut conn = seed();
        add_book(
            &mut conn,
            "b1",
            "书",
            &[&["plain text here"], &["star * not an operator"], &["quote a\"b inside"]],
        );

        // `*` is FTS5 prefix syntax and `"` breaks the query grammar: both have
        // to reach the index as ordinary characters.
        let star = hits(&conn, "star *", None);
        assert_eq!(star.len(), 1, "整句按字面匹配，星号不是前缀运算符");
        assert_eq!(star[0].chapter_idx, 1);

        let quote = hits(&conn, "a\"b", None);
        assert_eq!(quote.len(), 1, "引号必须被转义而不是破坏查询");
        assert_eq!(quote[0].chapter_idx, 2);
    }

    #[test]
    fn snippets_mark_the_match_and_keep_surrounding_context() {
        let mut conn = seed();
        let filler = "前".repeat(60);
        add_book(&mut conn, "b1", "书", &[&[&format!("{filler}命中{filler}")]]);

        let found = hits(&conn, "命中", None);
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].snippet,
            format!("…{}\u{2}命中\u{3}{}…", "前".repeat(40), "前".repeat(40)),
            "片段要标记命中并截断上下文"
        );
        assert_eq!(found[0].offset, 60);
    }

    #[test]
    fn deleting_a_book_removes_its_chapters_from_the_index() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["会被删除的正文"]]);
        assert_eq!(hits(&conn, "删除", None).len(), 1);

        conn.execute("DELETE FROM books WHERE id = 'b1'", []).expect("delete");
        assert!(hits(&conn, "删除", None).is_empty(), "级联删除后索引必须同步");
    }

    #[test]
    fn chapters_inserted_later_are_indexed_too() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["第一批正文"]]);
        // Mirrors the lazy back-fill a pre-Phase-3 book goes through.
        add_book(&mut conn, "b2", "另一本", &[&["第二批正文"]]);

        assert_eq!(hits(&conn, "第二批", None).len(), 1, "触发器必须覆盖后插入的章节");
        assert_eq!(chapters::count(&conn, "b2").expect("count"), 1);
    }
}
