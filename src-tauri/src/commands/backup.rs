//! `backup.*` commands: the whole library in one file, and back.
//!
//! Both do real disk work over every file in the library, so both run on a
//! blocking task rather than on the async runtime the UI waits on.

use std::path::Path;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library;
use crate::library::backup::BackupSummary;
use crate::state::AppState;

/// `backup.export`
#[tauri::command]
#[specta::specta]
pub async fn backup_export(state: State<'_, AppState>, path: String) -> AppResult<BackupSummary> {
    let library = state.library.clone();
    let data_dir = state.layout.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library::backup::export(&library, &data_dir, Path::new(&path))
    })
    .await
    .map_err(|err| AppError::Message(format!("备份任务被中断：{err}")))?
}

/// `backup.stage`
///
/// Only unpacks the archive. Replacing the library happens on the next start,
/// which is why the caller is expected to restart the app afterwards.
#[tauri::command]
#[specta::specta]
pub async fn backup_stage(state: State<'_, AppState>, path: String) -> AppResult<BackupSummary> {
    let data_dir = state.layout.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library::backup::stage(&data_dir, Path::new(&path))
    })
    .await
    .map_err(|err| AppError::Message(format!("恢复任务被中断：{err}")))?
}
