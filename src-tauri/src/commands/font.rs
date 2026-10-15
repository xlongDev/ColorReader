//! `font.*` commands: the fonts the reader imported for the reading surface.
//!
//! The list, the import, the catalogue install and the delete live here. Serving
//! the bytes is the resource protocol's job (`/font/<id>`), so the renderer never
//! handles a path and the file never crosses IPC — a 20 MB CJK face per page turn
//! would be visible as stutter.

use std::path::Path;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::font_archive::{self, CatalogInstall};
use crate::library::fonts::{self, Font};
use crate::state::AppState;

/// `font.list` — every imported font, in the order they were added.
#[tauri::command]
#[specta::specta]
pub fn font_list(state: State<'_, AppState>) -> AppResult<Vec<Font>> {
    fonts::list(&state.library)
}

/// `font.import` — `path` is the font file the reader picked.
#[tauri::command]
#[specta::specta]
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
#[specta::specta]
pub fn font_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    fonts::remove(&state.library, &state.layout.fonts_dir, &id)
}

/// `font.install_catalog` — installs one catalogue face from the vendor's own
/// archive.
///
/// The request carries the archive's URL and the member's sha256, both taken
/// from `src/lib/fontCatalog.ts`. That is the right side to keep the catalogue
/// on — it is data about where fonts come from, and it is compiled into the same
/// signed bundle this command is — and this side contributes what the frontend
/// cannot do: a zip reader, a filesystem, and the hash comparison that decides
/// whether the bytes are the ones that were pinned.
///
/// No `spawn_blocking` here: `font_archive::install` does its own, around the
/// half that is blocking. The download is genuinely async and must not be put on
/// a blocking thread.
#[tauri::command]
#[specta::specta]
pub async fn font_install_catalog(
    state: State<'_, AppState>,
    request: CatalogInstall,
) -> AppResult<Font> {
    font_archive::install(state.library.clone(), state.layout.fonts_dir.clone(), request).await
}
