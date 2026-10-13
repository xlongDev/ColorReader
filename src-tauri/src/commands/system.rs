//! `system.*` commands: runtime facts the About panel and diagnostics need.

use std::time::Instant;

use serde::Serialize;
use tauri::{State, webview_version};

use crate::state::AppState;

/// Runtime description of the running application.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub app_name: String,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// WebView runtime version, when it can be detected.
    pub webview: Option<String>,
    /// Per-user data directory (database, caches, book packs).
    pub data_dir: String,
    /// Milliseconds since process start.
    pub uptime_ms: u64,
}

/// Whether the credentials in the database can be sealed on this machine.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatus {
    /// `true` when the OS credential store answered *and* every sealed
    /// credential opens. The settings page shows nothing at all when it is.
    pub available: bool,
    /// Why not, as a sentence to show as-is.
    pub detail: Option<String>,
}

/// `system.info`
#[tauri::command]
#[specta::specta]
pub fn system_info(state: State<'_, AppState>) -> SystemInfo {
    SystemInfo {
        app_name: env!("CARGO_PKG_NAME").to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        webview: webview_version().ok(),
        data_dir: state.layout.data_dir.to_string_lossy().to_string(),
        uptime_ms: to_millis(state.started_at),
    }
}

/// `system.secretsStatus` — asked before the reader types a key into a field
/// that could not be saved, rather than after.
///
/// Never fails: "the credential store is unusable" is the answer this exists to
/// deliver, not an error, and a settings page that could not render its warning
/// would be worse than one that renders nothing.
#[tauri::command]
#[specta::specta]
pub fn secrets_status(state: State<'_, AppState>) -> SecretsStatus {
    match crate::secrets::check(&state.library) {
        Ok(()) => SecretsStatus { available: true, detail: None },
        Err(detail) => SecretsStatus { available: false, detail: Some(detail) },
    }
}

fn to_millis(started_at: Instant) -> u64 {
    let millis = started_at.elapsed().as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uptime_is_monotonic() {
        let start = Instant::now();
        let first = to_millis(start);
        let second = to_millis(start);
        assert!(second >= first);
    }

    #[test]
    fn payload_uses_camel_case() {
        let info = SystemInfo {
            app_name: "colorreader".into(),
            app_version: "0.1.0".into(),
            os: "macos".into(),
            arch: "aarch64".into(),
            webview: None,
            data_dir: "/tmp".into(),
            uptime_ms: 1,
        };
        let value = serde_json::to_value(&info).expect("payload must serialize");
        assert!(value.get("appName").is_some());
        assert!(value.get("dataDir").is_some());
        assert_eq!(value["uptimeMs"], 1);
    }

    #[test]
    fn a_healthy_store_carries_no_excuse() {
        // The settings page shows a warning whenever `detail` is set, so an
        // empty string would put a line on screen that says nothing.
        let value = serde_json::to_value(SecretsStatus { available: true, detail: None })
            .expect("payload must serialize");
        assert_eq!(value["available"], true);
        assert_eq!(value["detail"], serde_json::Value::Null);
    }
}
