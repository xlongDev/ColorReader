//! `dictionary.*` commands: the platform's own dictionary, and the local ones
//! the reader has imported.
//!
//! `lookup_dictionary` is the one entry point the selection toolbar's 词典
//! action calls, and it walks the two local sources in order: the platform's
//! dictionary first (on macOS it is the best of the two), then the imported
//! bundles. Only when neither knows the term do the answers the frontend sees —
//! `Missing` / `Unavailable` — send it on to AI.

use std::path::Path;

use tauri::State;

use crate::dictionary::{self, Lookup};
use crate::error::{AppError, AppResult};
use crate::library::dictionaries::{self, Dictionary};
use crate::state::AppState;

/// `dictionary.lookup` — platform dictionary, then the imported ones.
///
/// The answer is a tagged value rather than an error, because "no entry" and
/// "no dictionary here" are answers: the popup falls through to AI on both and
/// only mentions the first.
#[tauri::command]
#[specta::specta]
pub async fn lookup_dictionary(state: State<'_, AppState>, term: String) -> AppResult<Lookup> {
    let platform = dictionary::define(&term);
    let miss_or_unavailable = match platform {
        Lookup::Found { text, .. } => return Ok(Lookup::Found { text, source: None }),
        other => other,
    };

    // Reading index and body files is blocking work, so it stays off the async
    // worker the command runs on.
    let library = state.library.clone();
    let root = state.layout.dictionaries_dir.clone();
    let local = tokio::task::spawn_blocking(move || dictionaries::lookup(&library, &root, &term))
        .await
        .map_err(|err| AppError::Message(format!("本地词典查询失败：{err}")))??;

    match local {
        Some(hit) => Ok(Lookup::Found { text: hit.text, source: Some(hit.source) }),
        None => Ok(miss_or_unavailable),
    }
}

/// `dictionary.list` — every imported dictionary, in the order they were added.
#[tauri::command]
#[specta::specta]
pub fn dictionary_list(state: State<'_, AppState>) -> AppResult<Vec<Dictionary>> {
    dictionaries::list(&state.library)
}

/// `dictionary.import` — `path` is the picked `.ifo`; its siblings are read
/// from the same directory.
#[tauri::command]
#[specta::specta]
pub async fn dictionary_import(state: State<'_, AppState>, path: String) -> AppResult<Dictionary> {
    let library = state.library.clone();
    let root = state.layout.dictionaries_dir.clone();
    tokio::task::spawn_blocking(move || dictionaries::import(&library, &root, Path::new(&path)))
        .await
        .map_err(|err| AppError::Message(format!("导入词典失败：{err}")))?
}

/// `dictionary.delete` — forgets one dictionary and removes its files.
#[tauri::command]
#[specta::specta]
pub fn dictionary_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    dictionaries::remove(&state.library, &state.layout.dictionaries_dir, &id)
}
