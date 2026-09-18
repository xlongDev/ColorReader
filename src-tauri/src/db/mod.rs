//! SQLite access: connection setup, PRAGMAs and the shared handle.
//!
//! There is exactly one connection, guarded by a mutex. That serializes
//! everything — reads included — which is the right trade for a single-user
//! library: it removes `SQLITE_BUSY` between our own commands entirely, and
//! every query here is a statement-sized read or one batched write.
//!
//! WAL is on for crash recovery and cheaper commits, not for concurrency: a
//! single connection cannot read while its own write transaction is open.
//! The invariant to keep is therefore about duration, not parallelism —
//! nothing slow belongs inside a [`Library::with`] closure. Parse, hash and
//! network first, then take the lock for the writes.

pub mod migrations;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, Transaction};

use crate::error::{AppError, AppResult};

/// File name of the library database inside the per-user data directory.
pub const DB_FILE: &str = "library.sqlite3";

/// Directory holding the imported source files.
const BOOKS_DIR: &str = "books";

/// Directory holding extracted cover images.
const COVERS_DIR: &str = "covers";

/// Directory holding imported dictionaries, one subdirectory per bundle.
const DICTIONARIES_DIR: &str = "dictionaries";

/// Directory holding fonts the reader imported for the reading surface.
const FONTS_DIR: &str = "fonts";

/// Resolved locations under the data directory.
#[derive(Debug, Clone)]
pub struct Layout {
    pub data_dir: PathBuf,
    pub books_dir: PathBuf,
    pub covers_dir: PathBuf,
    pub dictionaries_dir: PathBuf,
    pub fonts_dir: PathBuf,
}

impl Layout {
    /// Ensures every subdirectory exists. Called once during startup.
    pub fn create(data_dir: PathBuf) -> AppResult<Self> {
        let books_dir = data_dir.join(BOOKS_DIR);
        let covers_dir = data_dir.join(COVERS_DIR);
        let dictionaries_dir = data_dir.join(DICTIONARIES_DIR);
        let fonts_dir = data_dir.join(FONTS_DIR);
        std::fs::create_dir_all(&books_dir)?;
        std::fs::create_dir_all(&covers_dir)?;
        std::fs::create_dir_all(&dictionaries_dir)?;
        std::fs::create_dir_all(&fonts_dir)?;
        Ok(Self { data_dir, books_dir, covers_dir, dictionaries_dir, fonts_dir })
    }
}

/// The shared library database.
///
/// Cloning is cheap: every clone talks to the same connection, so a command can
/// hand one to a blocking task without borrowing application state.
#[derive(Clone)]
pub struct Library {
    conn: Arc<Mutex<Connection>>,
}

impl Library {
    /// Opens (or creates) the database, applies pending migrations and tunes
    /// the connection.
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        let path = data_dir.join(DB_FILE);
        let mut conn = Connection::open(&path)?;

        // `execute_batch` rather than `pragma_update` because these pragmas take
        // keyword values that bind awkwardly as parameters.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA temp_store = MEMORY;",
        )?;

        let mode: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(AppError::Message(format!("无法启用 WAL 模式，当前日志模式为 {mode}")));
        }

        let version = migrations::migrate(&mut conn)?;
        tracing::info!(path = %path.display(), schema = version, "书库数据库已就绪");

        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Runs `f` with the shared connection.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self.lock()?;
        f(&guard)
    }

    /// Runs `f` inside a single transaction. Changes commit only when `f`
    /// returns `Ok`.
    pub fn with_tx<T>(&self, f: impl FnOnce(&Transaction<'_>) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.lock()?;
        let tx = guard.transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| AppError::poisoned("library"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Harness {
        dir: PathBuf,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let library = Library::open(&dir).expect("open library");
            Self { dir, library }
        }

        fn keys(&self) -> Vec<String> {
            self.library
                .with(|conn| {
                    let mut stmt = conn.prepare("SELECT key FROM settings ORDER BY key")?;
                    let rows = stmt.query_map([], |row| row.get(0))?;
                    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
                })
                .expect("read back")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// The contract every `with_tx` caller leans on — sync's apply pass most of
    /// all, where books, highlights and bookmarks have to land together or not
    /// at all. Pins that a write made before the error does not survive it.
    #[test]
    fn a_failed_transaction_leaves_nothing_behind() {
        let h = Harness::new("db-tx-rollback");
        h.library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('a', '1', 1)",
                    [],
                )?;
                Ok(())
            })
            .expect("seed");

        let failed: AppResult<()> = h.library.with_tx(|tx| {
            tx.execute("INSERT INTO settings (key, value, updated_at) VALUES ('b', '2', 1)", [])?;
            Err(AppError::Message("中途失败".into()))
        });
        assert!(failed.is_err());

        assert_eq!(h.keys(), vec!["a".to_string()]);
    }
}
