//! `font.*` commands: the fonts the reader imported for the reading surface.
//!
//! Only the list, the import and the delete live here. Serving the bytes is the
//! resource protocol's job (`/font/<id>`), so the renderer never handles a path
//! and the file never crosses IPC — a 20 MB CJK face per page turn would be
//! visible as stutter.

use std::path::Path;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::fonts::{self, Font};
use crate::state::AppState;

/// `font.list` — every imported font, in the order they were added.
#[tauri::command]
pub fn font_list(state: State<'_, AppState>) -> AppResult<Vec<Font>> {
    fonts::list(&state.library)
}

/// `font.import` — `path` is the font file the reader picked.
#[tauri::command]
pub async fn font_import(state: State<'_, AppState>, path: String) -> AppResult<Font> {
    let library = state.library.clone();
    let root = state.layout.fonts_dir.clone();
    // Copying a face is tens of megabytes of blocking I/O.
    tokio::task::spawn_blocking(move || fonts::import(&library, &root, Path::new(&path)))
        .await
        .map_err(|err| AppError::Message(format!("导入字体失败：{err}")))?
}

/// `font.delete` — forgets one font and removes its bytes.
#[tauri::command]
pub fn font_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    fonts::remove(&state.library, &state.layout.fonts_dir, &id)
}
