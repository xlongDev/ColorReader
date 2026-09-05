//! `book.*` commands: shelf queries, import and mutations.
//!
//! Read-only queries stay synchronous: they touch an indexed table and return
//! in microseconds. Anything that hashes or unlinks files moves to a blocking
//! task so the UI thread never waits on the disk.

use std::io::Read;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::library::import::{self, ImportOutcome};
use crate::library::repository::{BookQuery, BookSummary, LibraryStats};
use crate::library::{self};
use crate::state::AppState;

/// Emitted once per file while an import batch runs.
pub const IMPORT_PROGRESS_EVENT: &str = "book://import-progress";

/// `book.list`
#[tauri::command]
pub fn book_list(state: State<'_, AppState>, query: BookQuery) -> AppResult<Vec<BookSummary>> {
    state.library.with(|conn| crate::library::repository::list(conn, &query))
}

/// `book.get`
#[tauri::command]
pub fn book_get(state: State<'_, AppState>, id: String) -> AppResult<Option<BookSummary>> {
    state.library.with(|conn| crate::library::repository::get(conn, &id))
}

/// `book.stats`
#[tauri::command]
pub fn book_stats(state: State<'_, AppState>) -> AppResult<LibraryStats> {
    state.library.with(crate::library::repository::stats)
}

/// `book.images` — every image in the book, in reading order, with the
/// chapter each one sits in. Powers the lightbox's book-wide browsing.
#[tauri::command]
pub fn book_images(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<crate::library::chapters::BookImage>> {
    state.library.with(|conn| crate::library::chapters::images(conn, &id))
}

/// Refuse to buffer more than this for a single in-book image.
const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

/// `book.asset` — raw bytes of one image inside a book's source EPUB.
///
/// Chapters reference images by archive entry path (see
/// `IMAGE_PARAGRAPH_PREFIX`); the reader calls this lazily so a chapter with
/// no images never touches the zip. Returns over the binary IPC channel.
#[tauri::command]
pub async fn book_asset(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> AppResult<tauri::ipc::Response> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if path.split('/').any(|segment| segment == "..") {
            return Err(AppError::Parse("非法的资源路径".into()));
        }
        let (file_path, format) = library.with(|conn| library::repository::source(conn, &id))?;
        if format != crate::document::BookFormat::Epub {
            return Err(AppError::Parse("该书不是 EPUB，没有内嵌资源".into()));
        }
        let file = std::fs::File::open(file_path)?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|err| AppError::Parse(format!("无法打开 EPUB 容器：{err}")))?;
        let entry = archive
            .by_name(&path)
            .map_err(|_| AppError::Parse(format!("EPUB 缺少资源：{path}")))?;
        let mut limited = entry.take(MAX_ASSET_BYTES);
        let mut bytes = Vec::new();
        limited.read_to_end(&mut bytes)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|err| AppError::Message(format!("读取资源任务被中断：{err}")))?
}

/// `book.import`
///
/// Takes absolute paths chosen by the native file dialog or dropped onto the
/// window. One bad file never aborts the batch; each outcome is returned so the
/// UI can summarise what happened.
///
/// `password` only matters to `.ctzx` packs. It travels as an argument rather
/// than in a prompt callback so the whole batch runs on one blocking task.
#[tauri::command]
pub async fn book_import(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    password: Option<String>,
) -> AppResult<Vec<ImportOutcome>> {
    let library = state.library.clone();
    let layout = state.layout.clone();
    let targets: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        import::import_files(
            &library,
            &layout,
            &targets,
            password.as_deref(),
            &mut |done, total, path| {
                // A closed window simply stops listening; losing the event is fine.
                let _ = app.emit(
                    IMPORT_PROGRESS_EVENT,
                    ImportProgress { done, total, path: path.to_string() },
                );
            },
        )
    })
    .await
    .map_err(|err| AppError::Message(format!("导入任务被中断：{err}")))?;

    let imported = outcomes.iter().filter(|outcome| outcome.is_success()).count();
    tracing::info!(imported, total = outcomes.len(), "导入批次完成");
    Ok(outcomes)
}

/// `pack.export` — writes one book to a `.ctz` or `.ctzx` file.
///
/// The destination extension picks the format: `.ctzx` requires `password` and
/// encrypts the archive with AES-256-GCM under an Argon2id key.
#[tauri::command]
pub async fn pack_export(
    state: State<'_, AppState>,
    id: String,
    path: String,
    password: Option<String>,
) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::pack::export(
            &library,
            &id,
            PathBuf::from(&path).as_path(),
            password.as_deref(),
        )
    })
    .await
    .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
}

/// `book.delete`
#[tauri::command]
pub async fn book_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || library::delete_book(&library, &id))
        .await
        .map_err(|err| AppError::Message(format!("删除任务被中断：{err}")))?
}

/// `book.setFavorite`
#[tauri::command]
pub fn book_set_favorite(state: State<'_, AppState>, id: String, favorite: bool) -> AppResult<()> {
    state.library.with(|conn| crate::library::repository::set_favorite(conn, &id, favorite))
}

/// Progress payload for [`IMPORT_PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub done: usize,
    pub total: usize,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_payload_is_camel_case() {
        let value = serde_json::to_value(ImportProgress {
            done: 2,
            total: 5,
            path: "/books/a.epub".into(),
        })
        .expect("payload must serialize");
        assert_eq!(value["done"], 2);
        assert_eq!(value["total"], 5);
        assert_eq!(value["path"], "/books/a.epub");
    }

    #[test]
    fn progress_event_is_namespaced() {
        assert!(IMPORT_PROGRESS_EVENT.starts_with("book://"));
    }
}
