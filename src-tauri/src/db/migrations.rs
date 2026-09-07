//! Versioned schema applied through SQLite's `user_version` pragma.
//!
//! Each entry is applied at most once, inside a transaction together with the
//! version bump, so a crash half way through leaves the database at the previous
//! version instead of a half-created schema. Migrations are append-only: never
//! edit an entry that has shipped.

use rusqlite::Connection;

use crate::error::AppResult;

/// One irreversible schema step.
pub struct Migration {
    /// Monotonic, gap-free, starting at 1.
    pub version: u32,
    /// Short snake_case name, used in logs.
    pub name: &'static str,
    pub sql: &'static str,
}

/// All migrations in application order.
///
/// Book identity is `content_hash` (SHA-256 of the source bytes), which is the
/// dedupe key for imports. `sort_title` is precomputed on the Rust side so the
/// UI can sort without shipping a collation into SQLite.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init_library",
        sql: r#"
CREATE TABLE books (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  sort_title   TEXT NOT NULL,
  subtitle     TEXT,
  description  TEXT,
  language     TEXT,
  publisher    TEXT,
  identifier   TEXT,
  format       TEXT NOT NULL CHECK (format IN ('epub', 'txt', 'markdown')),
  content_hash TEXT NOT NULL UNIQUE,
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  cover_path   TEXT,
  added_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_read_at INTEGER,
  progress     REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  favorite     INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1))
);

CREATE INDEX books_added_at ON books (added_at DESC);
CREATE INDEX books_last_read_at ON books (last_read_at DESC) WHERE last_read_at IS NOT NULL;
CREATE INDEX books_sort_title ON books (sort_title COLLATE NOCASE);
CREATE INDEX books_favorite ON books (added_at DESC) WHERE favorite = 1;

CREATE TABLE authors (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  UNIQUE (name)
);

CREATE INDEX authors_sort_name ON authors (sort_name COLLATE NOCASE);

CREATE TABLE book_authors (
  book_id   TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES authors (id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (book_id, author_id)
);

CREATE INDEX book_authors_author ON book_authors (author_id);

CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  UNIQUE (name)
);

CREATE TABLE book_tags (
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);

CREATE INDEX book_tags_tag ON book_tags (tag_id);
"#,
    },
    Migration {
        version: 2,
        name: "init_chapters",
        // The reader engine works on chapter granularity: the import pipeline
        // extracts plain-text chapters once and the reader loads one chapter at a
        // time, so no book-sized payload ever crosses the IPC boundary.
        // Paragraphs are single lines joined with `\n`; `chars` is the chapter's
        // character count, which lets the frontend map a global progress fraction
        // onto a chapter without loading any content.
        sql: r#"
CREATE TABLE chapters (
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  title   TEXT NOT NULL,
  content TEXT NOT NULL,
  chars   INTEGER NOT NULL,
  PRIMARY KEY (book_id, idx)
);
"#,
    },
    Migration {
        version: 3,
        name: "init_annotations",
        // A highlight anchors to immutable chapter text by character range. The
        // offsets are UTF-16 code-unit counts computed and interpreted only by
        // the frontend; the backend stores them opaquely and keeps `text` as the
        // snippet shown in the list (and the future re-location key). Chapter
        // content never changes for a given book (re-import is a new hash), so
        // no re-location runs today.
        sql: r#"
CREATE TABLE annotations (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  start_char  INTEGER NOT NULL,
  end_char    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX annotations_book ON annotations (book_id, chapter_idx, start_char);
"#,
    },
    Migration {
        version: 4,
        name: "init_chapters_fts",
        // Full-text index over chapter bodies. The table is `content`-less in
        // the sense that it stores no text of its own: it is an external
        // content table reading `chapters.content` through the rowid, so a
        // book's text lives exactly once on disk. Triggers keep the index in
        // sync with the chapters table, including the cascade that removes
        // chapters when a book is deleted.
        //
        // `trigram` is deliberate: the default `unicode61` tokenizer treats a
        // run of Han characters as ONE token, so searching 世界 inside 你好世界
        // would never match. Trigram indexes every three-character window and
        // therefore does substring matching in Chinese as well as English.
        sql: r#"
CREATE VIRTUAL TABLE chapters_fts USING fts5(
  content,
  content = 'chapters',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER chapters_fts_ai AFTER INSERT ON chapters BEGIN
  INSERT INTO chapters_fts (rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER chapters_fts_ad AFTER DELETE ON chapters BEGIN
  INSERT INTO chapters_fts (chapters_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER chapters_fts_au AFTER UPDATE ON chapters BEGIN
  INSERT INTO chapters_fts (chapters_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO chapters_fts (rowid, content) VALUES (new.rowid, new.content);
END;
"#,
    },
    Migration {
        version: 5,
        name: "init_settings",
        // Only backend-owned settings live here. They are the ones the renderer
        // must never hold: an API key sitting in a webview's localStorage is
        // readable by anything that can read the profile directory, and the
        // backend needs the key anyway because it performs the HTTP call.
        // Appearance settings stay in the renderer, where they belong.
        sql: r#"
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"#,
    },
    Migration {
        version: 6,
        name: "init_chunks",
        // A chunk is a run of chapter text anchored exactly like an annotation:
        // character offsets into the chapter's joined text. The embedding is
        // stored normalized as little-endian f32 bytes, so retrieval is a plain
        // dot product. `model` and `dims` ride along because embeddings from a
        // different model live in a different space — comparing them is noise.
        // Volumes here are thousands, not millions, so retrieval is a brute
        // force scan in Rust; an ANN index is added when the numbers demand it.
        sql: r#"
CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  start_char  INTEGER NOT NULL,
  end_char    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   BLOB NOT NULL,
  model       TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX chunks_book ON chunks (book_id);
CREATE INDEX chunks_model ON chunks (model, dims);
"#,
    },
    Migration {
        version: 7,
        name: "init_graph",
        // A knowledge graph extracted by the LLM, one book at a time. Entities
        // are keyed by (book, name) because the same character named slightly
        // differently is a different node the merge step cannot safely fold.
        // Relations store names directly instead of entity ids: a relation may
        // name something that never made it into the entity list, and a join
        // would silently drop it. Rebuilds replace the whole graph inside one
        // transaction, so a failed extraction never leaves half a graph.
        sql: r#"
CREATE TABLE entities (
  id      INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  mentions INTEGER NOT NULL,
  UNIQUE (book_id, name)
);

CREATE INDEX entities_book ON entities (book_id, mentions DESC);

CREATE TABLE entity_relations (
  id          INTEGER PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  object      TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL,
  UNIQUE (book_id, subject, relation, object)
);

CREATE INDEX entity_relations_book ON entity_relations (book_id);
CREATE INDEX entity_relations_subject ON entity_relations (book_id, subject);
CREATE INDEX entity_relations_object ON entity_relations (book_id, object);
"#,
    },
    Migration {
        version: 8,
        name: "init_sources",
        // Online book sources. The whole rule set lives in one JSON column on
        // purpose: a source is edited as a single document in the UI, and there
        // is no query that needs to reach into individual rules.
        sql: r#"
CREATE TABLE sources (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  rules      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
"#,
    },
    Migration {
        version: 9,
        name: "init_bookmarks",
        // A bookmark pins a position (chapter + fraction inside it). `label`
        // is the snippet shown in the list; like annotation offsets, the
        // fraction is only meaningful for the exact content it was saved with,
        // and re-importing a book creates a new content hash anyway.
        sql: r#"
CREATE TABLE bookmarks (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  fraction    REAL NOT NULL CHECK (fraction >= 0 AND fraction <= 1),
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX bookmarks_book ON bookmarks (book_id, chapter_idx, fraction);
"#,
    },
    Migration {
        version: 10,
        name: "books_format_unconstrained",
        // The set of readable formats is data, not schema: `BookFormat` names
        // it in Rust and it grows without a schema change, so the CHECK on
        // `format` has to go. SQLite cannot alter a constraint in place, so the
        // table is rebuilt the documented way: create, copy, drop, rename.
        //
        // [`migrate`] runs with foreign key enforcement off: with it on,
        // `DROP TABLE books` fires an implicit DELETE that cascades into every
        // table referencing it, and the rebuild would empty the whole library.
        sql: r#"
CREATE TABLE books_new (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  sort_title   TEXT NOT NULL,
  subtitle     TEXT,
  description  TEXT,
  language     TEXT,
  publisher    TEXT,
  identifier   TEXT,
  format       TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  cover_path   TEXT,
  added_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_read_at INTEGER,
  progress     REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  favorite     INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1))
);

INSERT INTO books_new
  (id, title, sort_title, subtitle, description, language, publisher, identifier,
   format, content_hash, file_path, file_size, cover_path, added_at, updated_at,
   last_read_at, progress, favorite)
SELECT
  id, title, sort_title, subtitle, description, language, publisher, identifier,
  format, content_hash, file_path, file_size, cover_path, added_at, updated_at,
  last_read_at, progress, favorite
FROM books;

DROP TABLE books;
ALTER TABLE books_new RENAME TO books;

CREATE INDEX books_added_at ON books (added_at DESC);
CREATE INDEX books_last_read_at ON books (last_read_at DESC) WHERE last_read_at IS NOT NULL;
CREATE INDEX books_sort_title ON books (sort_title COLLATE NOCASE);
CREATE INDEX books_favorite ON books (added_at DESC) WHERE favorite = 1;
"#,
    },
];

/// Applies every pending migration and returns the resulting schema version.
///
/// Enforcement of foreign keys is off while migrations run. A table rebuild
/// (migration 10) drops the table it replaces, and with enforcement on SQLite
/// answers a `DROP TABLE` with an implicit `DELETE` that cascades into every
/// child table. The pragma is a no-op inside a transaction, so it is switched
/// here rather than in the migration's SQL.
pub fn migrate(conn: &mut Connection) -> AppResult<u32> {
    let current = schema_version(conn)?;
    let enforced = foreign_keys_enforced(conn)?;
    conn.pragma_update(None, "foreign_keys", "OFF")?;

    let result = apply_pending(conn, current);
    if enforced {
        conn.pragma_update(None, "foreign_keys", "ON")?;
    }
    result
}

fn apply_pending(conn: &mut Connection, current: u32) -> AppResult<u32> {
    for migration in MIGRATIONS {
        if migration.version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        // Setting `user_version` inside the transaction makes the schema change
        // and the version bump atomic.
        tx.pragma_update(None, "user_version", migration.version)?;
        tx.commit()?;
        tracing::info!(version = migration.version, name = migration.name, "迁移已应用");
    }

    schema_version(conn)
}

fn foreign_keys_enforced(conn: &Connection) -> AppResult<bool> {
    let value: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    Ok(value != 0)
}

/// Current `user_version`, i.e. the highest applied migration number.
pub fn schema_version(conn: &Connection) -> AppResult<u32> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database must open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        conn
    }

    #[test]
    fn migrations_are_contiguous_from_one() {
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            assert_eq!(migration.version as usize, index + 1, "版本号必须从 1 开始且连续");
        }
    }

    #[test]
    fn applying_twice_is_a_no_op() {
        let mut conn = fresh();
        assert_eq!(migrate(&mut conn).expect("first migrate"), MIGRATIONS.len() as u32);
        assert_eq!(migrate(&mut conn).expect("second migrate"), MIGRATIONS.len() as u32);
    }

    #[test]
    fn schema_creates_expected_tables() {
        let mut conn = fresh();
        migrate(&mut conn).expect("migrate");

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("prepare");
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows");

        for expected in ["books", "authors", "book_authors", "tags", "book_tags"] {
            assert!(tables.contains(&expected.to_string()), "缺少表 {expected}: {tables:?}");
        }
    }

    #[test]
    fn rebuilding_books_keeps_every_row_and_accepts_new_formats() {
        // Start from the schema as it was before the rebuild, with data in a
        // child table: the point of the test is that nothing is lost.
        let mut conn = fresh();
        for migration in &MIGRATIONS[..9] {
            conn.execute_batch(migration.sql).expect("apply v9 schema");
        }
        conn.pragma_update(None, "user_version", 9).expect("pin version");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn.execute("INSERT INTO authors (id, name, sort_name) VALUES ('a', 'A', 'a')", [])
            .expect("insert author");
        conn.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES ('b', 'a', 1)",
            [],
        )
        .expect("link");

        assert_eq!(migrate(&mut conn).expect("migrate"), 10);

        let title: String = conn
            .query_row("SELECT title FROM books WHERE id = 'b'", [], |row| row.get(0))
            .expect("书必须还在");
        assert_eq!(title, "T");
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_authors", [], |row| row.get(0))
            .expect("count");
        assert_eq!(links, 1, "DROP TABLE 不得级联删掉子表行");

        // The constraint that blocked new formats is gone.
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('c', 'C', 'c', 'cbz', 'h2', 'p2', 1, 1, 1)",
            [],
        )
        .expect("新格式必须能入库");
    }

    #[test]
    fn deleting_a_book_cascades_to_its_authors() {
        let mut conn = fresh();
        migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn.execute("INSERT INTO authors (id, name, sort_name) VALUES ('a', 'A', 'a')", [])
            .expect("insert author");
        conn.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES ('b', 'a', 1)",
            [],
        )
        .expect("link");

        conn.execute("DELETE FROM books WHERE id = 'b'", []).expect("delete");

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_authors", [], |row| row.get(0))
            .expect("count");
        assert_eq!(left, 0, "外键级联没有生效");
    }

    #[test]
    fn content_hash_is_unique() {
        let mut conn = fresh();
        migrate(&mut conn).expect("migrate");
        let insert = "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                      file_size, added_at, updated_at) \
                      VALUES (?1, 'T', 't', 'epub', 'same', 'p', 1, 1, 1)";
        conn.execute(insert, ("one",)).expect("first insert");
        assert!(conn.execute(insert, ("two",)).is_err(), "相同哈希必须被拒绝");
    }
}
