//! SQLite access: connection setup, PRAGMAs and the shared handle.
//!
//! The library owns a single writer connection guarded by a mutex. SQLite
//! already serializes writers, so one connection avoids `SQLITE_BUSY` churn
//! between our own commands while WAL keeps readers from blocking on it.

pub mod migrations;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, Transaction};

use crate::error::{AppError, AppResult};

/// File name of the library database inside the per-user data directory.
const DB_FILE: &str = "library.sqlite3";

/// Directory holding the imported source files.
const BOOKS_DIR: &str = "books";

/// Directory holding extracted cover images.
const COVERS_DIR: &str = "covers";

/// Resolved locations under the data directory.
#[derive(Debug, Clone)]
pub struct Layout {
    pub data_dir: PathBuf,
    pub books_dir: PathBuf,
    pub covers_dir: PathBuf,
}

impl Layout {
    /// Ensures every subdirectory exists. Called once during startup.
    pub fn create(data_dir: PathBuf) -> AppResult<Self> {
        let books_dir = data_dir.join(BOOKS_DIR);
        let covers_dir = data_dir.join(COVERS_DIR);
        std::fs::create_dir_all(&books_dir)?;
        std::fs::create_dir_all(&covers_dir)?;
        Ok(Self { data_dir, books_dir, covers_dir })
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
