//! `stats.*` commands: reading time in, reading time out.

use tauri::State;

use crate::error::AppResult;
use crate::library::stats::{self, ReadingStats};
use crate::state::AppState;

/// Trailing days the heat map draws: 26 weeks, the familiar GitHub width.
const WINDOW_DAYS: usize = 182;

/// `stats.recordSession` — adds `seconds` to today's row for `book_id`.
#[tauri::command]
pub fn stats_record_session(
    state: State<'_, AppState>,
    book_id: String,
    seconds: i64,
) -> AppResult<()> {
    state.library.with(|conn| stats::record_session(conn, &book_id, seconds))
}

/// `stats.reading` — today, the last week, the lifetime total, the streak and
/// the trailing days for the heat map.
#[tauri::command]
pub fn stats_reading(state: State<'_, AppState>) -> AppResult<ReadingStats> {
    state.library.with(|conn| stats::reading_stats(conn, WINDOW_DAYS))
}
