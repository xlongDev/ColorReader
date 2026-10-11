//! `ocr.*` — reading the text out of a scanned page.
//!
//! One command, one page. Whole-book recognition is deliberately not here yet:
//! it is the same call in a loop, and what it needs on top (a progress event,
//! a cancel, a cost the reader can see before committing to a hundred pages)
//! is worth building once the single page has proved the model and the
//! prompt against a real scan.

use serde::Serialize;
use tauri::State;

use crate::ai::{self, is_ready, vision};
use crate::error::{AppError, AppResult};
use crate::library::ocr;
use crate::state::AppState;

use super::ai::NOT_CONFIGURED;

/// What one page contributed.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPage {
    /// 1-based, the number the reader is looking at.
    pub page: usize,
    /// Characters now stored for it, which is what search and read-aloud see.
    pub chars: usize,
}

/// `ocr.page` — recognise one page and store it as that chapter's body.
///
/// `image` is a base64 data URL, not raw bytes: the provider takes it in that
/// form anyway, so decoding it here would only be a second copy of a page
/// that may be a megabyte.
#[tauri::command]
#[specta::specta]
pub async fn ocr_page(
    state: State<'_, AppState>,
    book_id: String,
    page: usize,
    image: String,
) -> AppResult<OcrPage> {
    let config = ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }
    // Checked before the request, not after: sending a megabyte to a provider
    // only to be told the page number was wrong is the worst of both.
    ocr::prepare_page(&state.library, &book_id, page)?;

    let client = super::ai::client()?;
    let text = vision::transcribe(&client, &config, &image).await?;
    let chars = ocr::write_page(&state.library, &book_id, page, &text)?;
    tracing::info!(book = %book_id, page, chars, "扫描页已识别");
    Ok(OcrPage { page: page + 1, chars })
}
