//! `ocr.*` — reading the text out of a scanned page.
//!
//! One page per call, plus the list a whole-book run is driven by. The loop
//! itself is **not here**: rendering a page is `pdfOcr.ts` on the frontend and
//! Rust has no PDF renderer, so a batch loop on this side would have to ask the
//! frontend for every image anyway. Doing it in the frontend makes the progress
//! plain React state instead of a stream of events, and leaves this side with
//! the two things only it can answer — which pages still need recognising, and
//! storing the answer.

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

/// `ocr.scannedPages` — which pages of a book still have no text, and how many
/// pages the book has, so the reader can be quoted "210 / 756" before a run
/// that may take a quarter of an hour.
///
/// 🔴 **Deliberately not gated on the model being configured**, unlike
/// [`ocr_page`]. The question this answers is about the book, not about the
/// provider, and the answer is a plain read of the corpus. Gating it would mean
/// the frontend duplicating `is_ready`'s rule to decide whether to offer the
/// button — and the frontend already has the pattern that avoids exactly that:
/// press, and let the backend's error say what is missing. The first page of a
/// batch fails with the same message `ocr_page` gives a single page, before
/// anything is uploaded.
///
/// Dispatched to a blocking worker rather than answered inline, and for a real
/// reason: the corpus may be a deferred PDF whose text was never extracted, and
/// paying that debt is a full document decode. Same treatment as `reader.toc`,
/// which pays the same debt.
#[tauri::command]
#[specta::specta]
pub async fn ocr_scanned_pages(
    state: State<'_, AppState>,
    book_id: String,
) -> AppResult<ocr::OcrScan> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || ocr::scanned_pages(&library, &book_id))
        .await
        .map_err(|err| AppError::Message(format!("扫描页统计被中断：{err}")))?
}
