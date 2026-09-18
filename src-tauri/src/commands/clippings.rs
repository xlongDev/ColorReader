//! `clippings.*` commands: highlights in, from Kindle or from this app's own
//! exports.

use std::fs;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::clippings::{self, Outcome, Shape};
use crate::state::AppState;

/// A clippings file is text and grows for years; anything past this is not one
/// and reading it whole would only waste memory.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// `clippings.import` — turns a file of highlights into highlights on the books
/// it can match.
///
/// Three shapes go in and one report comes out: Kindle's `My Clippings.txt`, and
/// the Markdown and CSV files this app exports. Which one it is is decided by
/// [`clippings::detect`] from the file's own content, so a renamed file still
/// reads.
///
/// `dry_run` walks the same path and writes nothing, which is what the dialog
/// shows before the reader commits: the same report either way, so the numbers
/// on the button are the numbers they get.
///
/// The file is read whole and then written to the database, which is seconds of
/// work on a clipping file that has been growing for years — hence the blocking
/// task rather than a synchronous command.
#[tauri::command]
#[specta::specta]
pub async fn clippings_import(
    state: State<'_, AppState>,
    path: String,
    dry_run: bool,
) -> AppResult<Outcome> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path)
            .map_err(|err| AppError::InvalidArgument(format!("读不到这个文件：{err}")))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(AppError::InvalidArgument(
                "这个文件太大了，不像是摘录文件".into(),
            ));
        }
        // Kindle has written UTF-8 since the first model, but a file that went
        // through a Windows editor may not be; the lossy read keeps the parts
        // that are fine instead of failing the whole import over one bad byte.
        // The same tolerance covers an export edited on a machine that is not
        // this one.
        let source = String::from_utf8_lossy(&bytes);
        let parsed = match clippings::detect(&source) {
            Shape::Kindle => clippings::parse(&source),
            Shape::Markdown => clippings::parse_markdown(&source),
            Shape::Csv => clippings::parse_csv(&source),
        };
        if parsed.highlights.is_empty() {
            return Err(AppError::InvalidArgument(
                "没有解析到任何标注。支持 Kindle 的 My Clippings.txt，以及本应用导出的 .md / .csv。".into(),
            ));
        }

        if dry_run {
            library.with(|conn| clippings::import(conn, &parsed, true))
        } else {
            library.with_tx(|tx| clippings::import(tx, &parsed, false))
        }
    })
    .await
    .map_err(|err| AppError::Message(format!("导入摘录任务被中断：{err}")))?
}
