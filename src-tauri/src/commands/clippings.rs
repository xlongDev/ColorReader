//! `clippings.*` commands: Kindle `My Clippings.txt` import.

use std::fs;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::clippings::{self, Outcome};
use crate::state::AppState;

/// A clippings file is text and grows for years; anything past this is not one
/// and reading it whole would only waste memory.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// `clippings.import` — turns a Kindle clippings file into highlights on the
/// books it can match.
///
/// `dry_run` walks the same path and writes nothing, which is what the dialog
/// shows before the reader commits: the same report either way, so the numbers
/// on the button are the numbers they get.
#[tauri::command]
pub fn clippings_import(
    state: State<'_, AppState>,
    path: String,
    dry_run: bool,
) -> AppResult<Outcome> {
    let bytes = fs::read(&path)
        .map_err(|err| AppError::InvalidArgument(format!("读不到这个文件：{err}")))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AppError::InvalidArgument("这个文件太大了，不像是 Kindle 的摘录文件".into()));
    }
    // Kindle has written UTF-8 since the first model, but a file that went
    // through a Windows editor may not be; the lossy read keeps the parts that
    // are fine instead of failing the whole import over one bad byte.
    let source = String::from_utf8_lossy(&bytes);
    let parsed = clippings::parse(&source);
    if parsed.highlights.is_empty() {
        return Err(AppError::InvalidArgument(
            "没有解析到任何高亮，确认选的是 Kindle 的 My Clippings.txt".into(),
        ));
    }

    if dry_run {
        state.library.with(|conn| clippings::import(conn, &parsed, true))
    } else {
        state.library.with_tx(|tx| clippings::import(tx, &parsed, false))
    }
}
