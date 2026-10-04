//! `tts.*` commands: the Edge read-aloud engine.
//!
//! The renderer never reaches this service directly. The handshake needs
//! headers its own webview refuses to let script set, and the signature is a
//! hash of the raw clock, so both live behind the IPC boundary.

use crate::error::AppResult;
use crate::tts::{self, EdgeClip, EdgeVoice};

/// `tts.edgeVoices` — every voice the service offers.
#[tauri::command]
#[specta::specta]
pub async fn tts_edge_voices() -> AppResult<Vec<EdgeVoice>> {
    tts::voices().await
}

/// `tts.edgeSpeak` — one utterance, with its word timings.
///
/// No rate: the clip comes back at the service's own pace and the renderer
/// stretches it to the reader's speed, so one clip answers for every speed.
#[tauri::command]
#[specta::specta]
pub async fn tts_edge_speak(text: String, voice: String) -> AppResult<EdgeClip> {
    tts::speak(&text, &voice).await
}
