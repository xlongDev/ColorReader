//! WebDAV reading-progress sync.
//!
//! One JSON document (`state.json`) lives in a user-chosen WebDAV collection.
//! Entries are keyed by `content_hash`, so the same book file on two machines
//! maps to the same entry with no central registry. The merge is last-writer-
//! wins per book by `updated_at`, ties go to the remote, and every decision is
//! reported back so "not a blind overwrite" is visible in the UI. A remote
//! document that fails to parse aborts the sync: overwriting a corrupt-but-
//! recoverable state file with ours would destroy the other device's data.
//!
//! Password lives in SQLite next to the AI key, for the same reason: the
//! renderer must never hold backend-owned secrets.

use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Where the state document lives and how to sign in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// WebDAV collection, e.g. `https://dav.example.com/dav/ColorReader`.
    pub url: String,
    /// Empty means the server needs no authentication.
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

const KEY: &str = "sync.webdav";
const DEVICE_KEY: &str = "sync.device_id";
const STATE_FILE: &str = "state.json";

/// Persisted config, or blanks when nothing has been saved yet.
pub fn config(library: &Library) -> AppResult<SyncConfig> {
    library.with(|conn| {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |row| row.get(0))
            .optional()?;
        match stored {
            Some(json) => serde_json::from_str(&json)
                .map_err(|err| AppError::Message(format!("同步配置已损坏，请重新填写：{err}"))),
            None => Ok(SyncConfig::default()),
        }
    })
}

/// Writes the config back after trimming; the URL shape is validated here.
pub fn set_config(library: &Library, next: &SyncConfig) -> AppResult<SyncConfig> {
    let stored = SyncConfig {
        url: normalize_url(&next.url)?,
        username: next.username.trim().to_string(),
        password: next.password.clone(),
    };
    let json = serde_json::to_string(&stored)?;
    library.with(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                               updated_at = excluded.updated_at",
            rusqlite::params![KEY, json, crate::library::now_seconds()],
        )?;
        Ok(())
    })?;
    Ok(stored)
}

/// Same transport rule as the AI endpoint: TLS everywhere, loopback may use
/// plain HTTP because a local WebDAV server is still a legitimate setup.
pub(crate) fn normalize_url(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::InvalidArgument("服务器地址不能为空".into()));
    }
    let is_loopback_http = trimmed.starts_with("http://localhost")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://[::1]");
    if !trimmed.starts_with("https://") && !is_loopback_http {
        return Err(AppError::InvalidArgument(
            "服务器地址必须是 https，本机服务可用 http://localhost".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// The stable id this installation signs state writes with.
pub fn device_id(library: &Library) -> AppResult<String> {
    library.with(|conn| {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [DEVICE_KEY], |row| row.get(0))
            .optional()?;
        if let Some(id) = stored {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![DEVICE_KEY, id, crate::library::now_seconds()],
        )?;
        Ok(id)
    })
}

/// One book's synced position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBook {
    pub progress: f64,
    /// Unix seconds of the last write to this entry.
    pub updated_at: i64,
    /// Device that produced this entry, for human inspection only.
    pub device_id: String,
    /// Book title so devices without the book can still show something.
    #[serde(default)]
    pub title: String,
}

/// The cloud document, version 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub version: u32,
    pub device_id: String,
    pub updated_at: i64,
    /// Keyed by `content_hash`; a BTreeMap keeps the serialized form stable.
    pub books: BTreeMap<String, RemoteBook>,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self { version: 1, device_id: String::new(), updated_at: 0, books: BTreeMap::new() }
    }
}

/// What the local database knows about one read book.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalBook {
    pub content_hash: String,
    pub title: String,
    /// 0..1.
    pub progress: f64,
    /// Unix seconds.
    pub updated_at: i64,
}

/// What the merge decided for one book. Struct variants so the serialized
/// form is a flat `{ decision, title, progress }` object.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "decision")]
pub enum Change {
    /// Only the local side knew this position; it went up.
    Uploaded { title: String, progress: f64 },
    /// The remote entry was newer and has been applied to the local database.
    Downloaded { title: String, progress: f64 },
    /// The remote holds a book this device has not imported; left untouched.
    RemoteOnly { title: String, progress: f64 },
    /// Both sides agree.
    Unchanged { title: String, progress: f64 },
}

impl Change {
    pub fn title(&self) -> &str {
        match self {
            Change::Uploaded { title, .. }
            | Change::Downloaded { title, .. }
            | Change::RemoteOnly { title, .. }
            | Change::Unchanged { title, .. } => title,
        }
    }
}

/// Pure merge: the union of both sides with per-book last-writer-wins.
///
/// Ties go to the remote so two devices syncing in the same second converge
/// instead of flip-flopping. The returned state is what should be PUT back.
pub fn merge(
    local: &[LocalBook],
    remote: Option<RemoteState>,
    device_id: &str,
    now: i64,
) -> (RemoteState, Vec<Change>) {
    let mut state = remote.unwrap_or_default();
    state.version = 1;
    state.device_id = device_id.to_string();
    state.updated_at = now;

    let mut changes = Vec::new();
    for book in local {
        let entry = RemoteBook {
            progress: book.progress.clamp(0.0, 1.0),
            updated_at: book.updated_at,
            device_id: device_id.to_string(),
            title: book.title.clone(),
        };
        match state.books.get(&book.content_hash) {
            None => {
                state.books.insert(book.content_hash.clone(), entry);
                changes
                    .push(Change::Uploaded { title: book.title.clone(), progress: book.progress });
            }
            Some(cloud) => {
                // Position equality decides first: comparing wall clocks when
                // both sides agree would churn an upload on every sync.
                let same = (cloud.progress - book.progress).abs() < f64::EPSILON;
                if same {
                    changes.push(Change::Unchanged {
                        title: book.title.clone(),
                        progress: book.progress,
                    });
                } else if cloud.updated_at >= book.updated_at {
                    changes.push(Change::Downloaded {
                        title: book.title.clone(),
                        progress: cloud.progress,
                    });
                } else {
                    state.books.insert(book.content_hash.clone(), entry);
                    changes.push(Change::Uploaded {
                        title: book.title.clone(),
                        progress: book.progress,
                    });
                }
            }
        }
    }

    // Books the local library has never seen stay in the state for the device
    // that does have them.
    for (hash, cloud) in &state.books {
        if !local.iter().any(|book| &book.content_hash == hash) {
            changes.push(Change::RemoteOnly {
                title: if cloud.title.is_empty() { hash.clone() } else { cloud.title.clone() },
                progress: cloud.progress,
            });
        }
    }
    changes.sort_by(|a, b| a.title().cmp(b.title()));
    (state, changes)
}

/// Reads every book the user has actually opened.
pub fn local_books(conn: &rusqlite::Connection) -> AppResult<Vec<LocalBook>> {
    let mut stmt = conn.prepare(
        "SELECT content_hash, title, progress, last_read_at FROM books
          WHERE last_read_at IS NOT NULL ORDER BY title",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(LocalBook {
            content_hash: row.get(0)?,
            title: row.get(1)?,
            progress: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

/// Applies one downloaded position; `false` when the book is not imported here.
pub fn apply_downloaded(
    conn: &rusqlite::Connection,
    hash: &str,
    book: &RemoteBook,
) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE books SET progress = ?1, last_read_at = ?2, updated_at = ?3
          WHERE content_hash = ?4",
        rusqlite::params![
            book.progress.clamp(0.0, 1.0),
            book.updated_at,
            crate::library::now_seconds(),
            hash
        ],
    )?;
    Ok(changed > 0)
}

fn state_url(dir_url: &str) -> String {
    format!("{dir_url}/{STATE_FILE}")
}

/// Cumulative collection URLs to MKCOL, first missing ancestor first.
pub(crate) fn collection_urls(dir_url: &str) -> Vec<String> {
    let Some(host_end) = dir_url.find("://") else { return Vec::new() };
    let Some(path_start) = dir_url[host_end + 3..].find('/') else { return Vec::new() };
    let path_start = host_end + 3 + path_start;
    let (base, path) = dir_url.split_at(path_start);
    let mut urls = Vec::new();
    let mut current = String::from(base);
    for segment in path.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            continue;
        }
        current.push('/');
        current.push_str(segment);
        urls.push(current.clone());
    }
    urls
}

fn http() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|err| AppError::Message(format!("无法创建 HTTP 客户端：{err}")))
}

/// GET + MKCOL + PUT against WebDAV, with basic auth when a username is set.
struct Dav<'a> {
    client: reqwest::Client,
    config: &'a SyncConfig,
}

impl Dav<'_> {
    fn new(config: &SyncConfig) -> AppResult<Dav<'_>> {
        Ok(Dav { client: http()?, config })
    }

    fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.auth(self.client.get(url))
    }

    fn auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.config.username.is_empty() {
            builder
        } else {
            builder.basic_auth(&self.config.username, Some(&self.config.password))
        }
    }

    /// Fetches the state document; `None` when it does not exist yet.
    async fn pull(&self) -> AppResult<Option<RemoteState>> {
        let url = state_url(&self.config.url);
        let response = self.get(&url).send().await.map_err(net_error)?;
        match response.status() {
            reqwest::StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                let body = response.text().await.map_err(net_error)?;
                // A document we cannot understand must never be overwritten.
                serde_json::from_str(&body).map(Some).map_err(|err| {
                    AppError::Message(format!("云端状态文件无法解析，已中止同步：{err}"))
                })
            }
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                Err(AppError::InvalidArgument("WebDAV 用户名或密码不对".into()))
            }
            status => Err(AppError::Message(format!("读取云端状态失败：HTTP {status}"))),
        }
    }

    /// Creates any missing ancestor collections, then PUTs the document.
    async fn push(&self, state: &RemoteState) -> AppResult<()> {
        for url in collection_urls(&self.config.url) {
            // An existing collection answers 405; any other failure surfaces
            // for real at PUT time.
            let method =
                reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL is a valid HTTP method");
            let _ = self.auth(self.client.request(method, &url)).send().await;
        }
        let body = serde_json::to_string(state)?;
        let response = self
            .get(&state_url(&self.config.url))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(net_error)?;
        match response.status() {
            status if status.is_success() => Ok(()),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                Err(AppError::InvalidArgument("WebDAV 用户名或密码不对".into()))
            }
            status => Err(AppError::Message(format!("上传云端状态失败：HTTP {status}"))),
        }
    }
}

fn net_error(err: reqwest::Error) -> AppError {
    AppError::Message(format!("WebDAV 请求失败：{err}"))
}

/// Proves the server is reachable and the credentials work. Does not save.
pub async fn test_connection(config: &SyncConfig) -> AppResult<()> {
    let checked = SyncConfig { url: normalize_url(&config.url)?, ..config.clone() };
    let dav = Dav::new(&checked)?;
    // 404 is a success here: reachable, authorized, no state yet.
    dav.pull().await.map(|_| ())
}

/// The full sync cycle: pull, merge, apply downloads, push.
pub async fn run(library: &Library, config: &SyncConfig) -> AppResult<Vec<Change>> {
    let checked = SyncConfig { url: normalize_url(&config.url)?, ..config.clone() };
    let dav = Dav::new(&checked)?;
    let device = device_id(library)?;
    let remote = dav.pull().await?;

    let (local, changes) = {
        let (state, changes) =
            merge(&library.with(local_books)?, remote, &device, crate::library::now_seconds());
        library.with(|conn| {
            for (hash, book) in &state.books {
                apply_downloaded(conn, hash, book)?;
            }
            Ok(())
        })?;
        (state, changes)
    };
    dav.push(&local).await?;
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(hash: &str, title: &str, progress: f64, at: i64) -> LocalBook {
        LocalBook { content_hash: hash.into(), title: title.into(), progress, updated_at: at }
    }

    #[test]
    fn a_local_only_position_goes_up() {
        let (state, changes) = merge(&[book("h1", "三体", 0.5, 100)], None, "dev", 200);
        assert_eq!(state.version, 1);
        assert_eq!(state.device_id, "dev");
        assert_eq!(state.books["h1"].progress, 0.5);
        assert_eq!(changes, vec![Change::Uploaded { title: "三体".into(), progress: 0.5 }]);
    }

    #[test]
    fn a_newer_cloud_entry_wins_and_is_reported() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.8,
                updated_at: 300,
                device_id: "other".into(),
                title: "三体".into(),
            },
        );
        let (state, changes) = merge(&[book("h1", "三体", 0.5, 100)], Some(state), "dev", 400);
        assert_eq!(state.books["h1"].progress, 0.8, "云端较新时本地不得覆盖");
        assert_eq!(changes, vec![Change::Downloaded { title: "三体".into(), progress: 0.8 }]);
    }

    #[test]
    fn a_newer_local_entry_wins() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.2,
                updated_at: 50,
                device_id: "other".into(),
                title: "三体".into(),
            },
        );
        let (state, changes) = merge(&[book("h1", "三体", 0.6, 100)], Some(state), "dev", 400);
        assert_eq!(state.books["h1"].progress, 0.6);
        assert_eq!(changes, vec![Change::Uploaded { title: "三体".into(), progress: 0.6 }]);
    }

    #[test]
    fn a_tie_goes_to_the_cloud_so_devices_converge() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.4,
                updated_at: 100,
                device_id: "other".into(),
                title: "三体".into(),
            },
        );
        let (_, changes) = merge(&[book("h1", "三体", 0.6, 100)], Some(state), "dev", 400);
        assert_eq!(changes, vec![Change::Downloaded { title: "三体".into(), progress: 0.4 }]);
    }

    #[test]
    fn identical_sides_are_unchanged_even_when_the_local_clock_is_newer() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.5,
                updated_at: 100,
                device_id: "dev".into(),
                title: "三体".into(),
            },
        );
        // Same position, different wall clock: no upload churn.
        let (_, changes) = merge(&[book("h1", "三体", 0.5, 150)], Some(state), "dev", 400);
        assert_eq!(changes, vec![Change::Unchanged { title: "三体".into(), progress: 0.5 }]);
    }

    #[test]
    fn cloud_books_missing_locally_stay_listed() {
        let mut state = RemoteState::default();
        state.books.insert(
            "elsewhere".into(),
            RemoteBook {
                progress: 0.9,
                updated_at: 100,
                device_id: "other".into(),
                title: "只在那台设备上".into(),
            },
        );
        let (state, changes) = merge(&[], Some(state), "dev", 200);
        assert_eq!(state.books["elsewhere"].progress, 0.9, "别的设备的书不能被抹掉");
        assert_eq!(
            changes,
            vec![Change::RemoteOnly { title: "只在那台设备上".into(), progress: 0.9 }]
        );
    }

    #[test]
    fn the_state_file_sits_in_the_configured_collection() {
        assert_eq!(state_url("https://dav.x.com/dav/CR"), "https://dav.x.com/dav/CR/state.json");
    }

    #[test]
    fn every_missing_ancestor_is_created_in_order() {
        assert_eq!(
            collection_urls("https://dav.x.com/dav/CR"),
            ["https://dav.x.com/dav", "https://dav.x.com/dav/CR"]
        );
        assert!(collection_urls("https://dav.x.com").is_empty());
        assert!(collection_urls("not a url").is_empty());
    }

    #[test]
    fn urls_obey_the_tls_rule() {
        assert!(normalize_url("https://dav.x.com/dav/").is_ok());
        assert!(normalize_url("http://localhost:8080/dav").is_ok());
        assert!(normalize_url("http://dav.x.com").is_err());
        assert!(normalize_url("  ").is_err());
    }
}
