//! `sync.*` commands: WebDAV reading-progress sync.

use tauri::State;

use crate::error::AppResult;
use crate::library::sync::{self, Change, SyncConfig};
use crate::state::AppState;

/// `sync.getConfig`
#[tauri::command]
pub fn sync_get_config(state: State<'_, AppState>) -> AppResult<SyncConfig> {
    sync::config(&state.library)
}

/// `sync.setConfig` — returns the stored, normalized form.
#[tauri::command]
pub fn sync_set_config(state: State<'_, AppState>, config: SyncConfig) -> AppResult<SyncConfig> {
    sync::set_config(&state.library, &config)
}

/// `sync.test` — proves the server is reachable and authorized; does not save.
#[tauri::command]
pub async fn sync_test(config: SyncConfig) -> AppResult<()> {
    sync::test_connection(&config).await
}

/// `sync.now` — pull, merge, apply and push; returns the per-book decisions.
#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>, config: SyncConfig) -> AppResult<Vec<Change>> {
    sync::run(&state.library, &config).await
}
