//! `tag.*` and `book.setTags`: the shelf's labelling commands.

use tauri::State;

use crate::error::AppResult;
use crate::library::tags::{self, TagSummary};
use crate::state::AppState;

/// `tag.list`
#[tauri::command]
pub fn tag_list(state: State<'_, AppState>) -> AppResult<Vec<TagSummary>> {
    state.library.with(tags::list)
}

/// `tag.delete` — removes one tag from every book that carries it.
#[tauri::command]
pub fn tag_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.library.with(|conn| tags::delete(conn, &id))
}

/// `book.setTags` — applies a set difference to one or more books.
///
/// The per-book sheet computes `add`/`remove` against what it was shown; the
/// batch bar passes only `add`, so selecting ten books cannot clear a label
/// the bar never knew about. One command instead of two, because the operation
/// really is one: a difference applied to a set of books.
#[tauri::command]
pub fn book_set_tags(
    state: State<'_, AppState>,
    ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    state.library.with_tx(|tx| tags::assign(tx, &ids, &add, &remove))
}
