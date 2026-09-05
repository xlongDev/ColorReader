//! `bookmark.*` commands: create, list and delete reading-position pins.

use tauri::State;

use crate::error::AppResult;
use crate::library::bookmarks::{self, Bookmark};
use crate::state::AppState;

/// `bookmark.create` — pins the current position and returns it.
#[tauri::command]
pub fn bookmark_create(
    state: State<'_, AppState>,
    book_id: String,
    chapter_idx: usize,
    fraction: f64,
    label: String,
) -> AppResult<Bookmark> {
    state.library.with(|conn| bookmarks::create(conn, &book_id, chapter_idx, fraction, &label))
}

/// `bookmark.list` — every bookmark for a book, in reading order.
#[tauri::command]
pub fn bookmark_list(state: State<'_, AppState>, book_id: String) -> AppResult<Vec<Bookmark>> {
    state.library.with(|conn| bookmarks::list(conn, &book_id))
}

/// `bookmark.delete` — removes one bookmark.
#[tauri::command]
pub fn bookmark_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.library.with(|conn| bookmarks::delete(conn, &id))
}
