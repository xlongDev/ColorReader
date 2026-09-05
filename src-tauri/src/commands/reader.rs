//! `reader.*` commands: chapter index, chapter bodies and progress.
//!
//! Building a chapter index for a book imported before the reader engine
//! existed touches the source file, so that path runs on a blocking task; the
//! per-chapter body query is a single indexed row and stays synchronous.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::chapters::{self, ChapterContent, ChapterMeta};
use crate::library::repository;
use crate::state::AppState;

/// `reader.toc` — chapter metadata in reading order.
#[tauri::command]
pub async fn reader_toc(
    state: State<'_, AppState>,
    book_id: String,
) -> AppResult<Vec<ChapterMeta>> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || chapters::ensure(&library, &book_id))
        .await
        .map_err(|err| AppError::Message(format!("目录加载被中断：{err}")))?
}

/// `reader.chapter` — the body of one chapter.
#[tauri::command]
pub fn reader_chapter(
    state: State<'_, AppState>,
    book_id: String,
    idx: usize,
) -> AppResult<ChapterContent> {
    let found = state.library.with(|conn| chapters::content(conn, &book_id, idx))?;
    found.ok_or_else(|| AppError::NotFound(format!("第 {} 章", idx + 1)))
}

/// `reader.setProgress` — records a 0..1 reading position.
#[tauri::command]
pub fn reader_set_progress(
    state: State<'_, AppState>,
    book_id: String,
    progress: f64,
) -> AppResult<()> {
    state.library.with(|conn| repository::set_progress(conn, &book_id, progress))
}
