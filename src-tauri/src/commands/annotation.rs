//! `annotation.*` commands: create, restyle, anchor, note, list and delete
//! highlights.

use tauri::State;

use crate::error::AppResult;
use crate::library::annotations::{self, Annotation};
use crate::state::AppState;

/// `annotation.create` — records one highlight and returns it.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn annotation_create(
    state: State<'_, AppState>,
    book_id: String,
    chapter_idx: usize,
    start_char: usize,
    end_char: usize,
    text: String,
    // Opaque foliate anchor (a CFI) for Kindle books; absent otherwise.
    cfi: Option<String>,
    // Ink colour (hex) and paint style; absent = the legacy marker look.
    color: Option<String>,
    style: Option<String>,
) -> AppResult<Annotation> {
    state.library.with(|conn| {
        annotations::create(
            conn,
            &book_id,
            chapter_idx,
            start_char,
            end_char,
            &text,
            cfi.as_deref(),
            color.as_deref(),
            style.as_deref(),
        )
    })
}

/// `annotation.update` — restyles one highlight (re-colour / re-shape).
#[tauri::command]
#[specta::specta]
pub fn annotation_update(
    state: State<'_, AppState>,
    id: String,
    color: Option<String>,
    style: Option<String>,
) -> AppResult<Annotation> {
    state.library.with(|conn| annotations::update(conn, &id, color.as_deref(), style.as_deref()))
}

/// `annotation.anchor` — hands a highlight the foliate CFI it was imported
/// without. The reader calls it once it has located the highlight's text in a
/// section, which is the only place a CFI can be minted.
#[tauri::command]
#[specta::specta]
pub fn annotation_anchor(
    state: State<'_, AppState>,
    id: String,
    cfi: String,
) -> AppResult<Annotation> {
    state.library.with(|conn| annotations::anchor(conn, &id, &cfi))
}

/// `annotation.note` — writes the reader's own note on a highlight, or clears
/// it when `note` is absent or blank.
#[tauri::command]
#[specta::specta]
pub fn annotation_note(
    state: State<'_, AppState>,
    id: String,
    note: Option<String>,
) -> AppResult<Annotation> {
    state.library.with(|conn| annotations::set_note(conn, &id, note.as_deref()))
}

/// `annotation.list` — every highlight for a book, in reading order.
#[tauri::command]
#[specta::specta]
pub fn annotation_list(state: State<'_, AppState>, book_id: String) -> AppResult<Vec<Annotation>> {
    state.library.with(|conn| annotations::list(conn, &book_id))
}

/// `annotation.delete` — removes one highlight.
#[tauri::command]
#[specta::specta]
pub fn annotation_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.library.with(|conn| annotations::delete(conn, &id))
}
