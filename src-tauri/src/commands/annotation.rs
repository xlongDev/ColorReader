//! `annotation.*` commands: create, list and delete highlights.

use tauri::State;

use crate::error::AppResult;
use crate::library::annotations::{self, Annotation};
use crate::state::AppState;

/// `annotation.create` — records one highlight and returns it.
#[tauri::command]
pub fn annotation_create(
    state: State<'_, AppState>,
    book_id: String,
    chapter_idx: usize,
    start_char: usize,
    end_char: usize,
    text: String,
) -> AppResult<Annotation> {
    state
        .library
        .with(|conn| annotations::create(conn, &book_id, chapter_idx, start_char, end_char, &text))
}

/// `annotation.list` — every highlight for a book, in reading order.
#[tauri::command]
pub fn annotation_list(state: State<'_, AppState>, book_id: String) -> AppResult<Vec<Annotation>> {
    state.library.with(|conn| annotations::list(conn, &book_id))
}

/// `annotation.delete` — removes one highlight.
#[tauri::command]
pub fn annotation_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.library.with(|conn| annotations::delete(conn, &id))
}
