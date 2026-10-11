//! The rule every outbound request URL has to clear.
//!
//! Two callers need it and neither is the other: the AI endpoint carries an API
//! key, and a book source is a third-party JSON definition the reader imported
//! by pasting a URL. Both send a request on the reader's behalf to an address
//! somebody else chose, so neither may put it in clear text across a network
//! the reader does not control.
//!
//! `http://` on loopback stays usable — that is how Ollama, LM Studio and a
//! reader's own machine are reached, and it is the reader's own traffic either
//! way. Everything else has to be `https://`.
//!
//! One function rather than one copy per caller: two copies of a security rule
//! is how the second one quietly stops being applied when a new call site is
//! added.

use crate::error::{AppError, AppResult};

/// Trims whitespace and trailing slashes — so a later path join cannot produce
/// `//v1` — and refuses any scheme that would leave the request in clear text.
///
/// `label` names the setting in the message, because "接口地址必须是 https"
/// is wrong advice on a screen that is editing a book source.
pub fn secure_base_url(raw: &str, label: &str) -> AppResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::InvalidArgument(format!("{label}不能为空")));
    }
    let is_loopback_http = trimmed.starts_with("http://localhost")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://[::1]");
    if !trimmed.starts_with("https://") && !is_loopback_http {
        return Err(AppError::InvalidArgument(format!(
            "{label}必须是 https，本地可用 http://localhost"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_text_http_is_only_allowed_on_loopback() {
        assert!(secure_base_url("http://localhost:11434/v1", "接口地址").is_ok());
        assert!(secure_base_url("http://127.0.0.1:1234/v1", "接口地址").is_ok());
        assert!(secure_base_url("http://[::1]:1234/v1", "接口地址").is_ok());
        // The key travels in clear text, and so does every query the reader
        // types into a search box.
        assert!(secure_base_url("http://example.com/v1", "接口地址").is_err(), "外网必须走 https");
        assert!(secure_base_url("http://192.168.1.10/api", "接口地址").is_err(), "局域网也算外网");
        assert!(secure_base_url("ftp://x", "接口地址").is_err());
        assert!(secure_base_url("   ", "接口地址").is_err());
    }

    #[test]
    fn the_result_is_ready_to_join_a_path_onto() {
        assert_eq!(
            secure_base_url("  https://api.example.com/v1/  ", "接口地址").expect("https"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn the_message_names_the_setting_it_was_asked_about() {
        let err = secure_base_url("http://example.com", "书源地址").expect_err("must be rejected");
        assert!(err.to_string().contains("书源地址"), "{err}");
    }
}
