//! `notes.*` commands: getting highlights and notes back out of the app.

use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// `notes.export` — writes one book's highlights and notes to a readable file.
///
/// The destination extension picks the format (`.md` or `.csv`), the same
/// contract `pack.export` follows: what the save dialog promised is what gets
/// written. The write happens off the main thread because it reads the whole
/// annotation list and touches the disk — small work, but the reader is waiting
/// on a button.
#[tauri::command]
#[specta::specta]
pub async fn notes_export(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::export::export(&library, &id, PathBuf::from(&path).as_path())
    })
    .await
    .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
}

/// `notes.export_selection` — writes the highlights a screen is showing,
/// across as many books as they come from.
///
/// Two arguments rather than one because the two answer different questions:
/// `ids` is the set the reader narrowed to (a search, or 有笔记), and `book_ids`
/// is the order the screen put them in, which is the shelf's. Sending only the
/// ids would lose the order; sending only the books would lose the narrowing.
#[tauri::command]
#[specta::specta]
pub async fn notes_export_selection(
    state: State<'_, AppState>,
    book_ids: Vec<String>,
    ids: Vec<String>,
    path: String,
) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::export::export_selection(
            &library,
            &book_ids,
            &ids,
            PathBuf::from(&path).as_path(),
        )
    })
    .await
    .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
}
