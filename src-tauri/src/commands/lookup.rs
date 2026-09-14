//! `lookup.*` commands: the external references the selection toolbar queries —
//! DeepL for instant translation and Wikipedia for term summaries. The
//! dictionary actions live in `commands/dictionary.rs`, because theirs is not a
//! network call: the platform's own dictionary and the imported bundles are both
//! local.

use tauri::State;

use crate::ai::lookup::{self, Translation, WikiSummary};
use crate::error::AppResult;
use crate::state::AppState;

/// `lookup.translate` — one DeepL round trip, no streaming: a paragraph comes
/// back in well under a second and the popup renders it whole. The key lives
/// in the same settings row as the AI config; an empty key is the frontend's
/// signal to fall back to the streaming AI translation instead.
#[tauri::command]
pub async fn lookup_translate(state: State<'_, AppState>, text: String) -> AppResult<Translation> {
    let config = crate::ai::config(&state.library)?;
    let client = super::ai::client()?;
    lookup::deepl_translate(&client, &config.deepl_key, &text).await
}

/// `lookup.wikipedia` — best-matching article summary for a term, zh wiki
/// first for CJK selections with the English edition as fallback.
#[tauri::command]
pub async fn lookup_wikipedia(term: String) -> AppResult<WikiSummary> {
    let client = super::ai::client()?;
    lookup::wikipedia_summary(&client, &term).await
}
