//! `system.*` commands: runtime facts the About panel and diagnostics need.

use std::time::Instant;

use serde::Serialize;
use tauri::{State, webview_version};

use crate::state::AppState;

/// Runtime description of the running application.
#[derive(Debug, Clone, Serialize)]
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

/// `system.info`
#[tauri::command]
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
}
