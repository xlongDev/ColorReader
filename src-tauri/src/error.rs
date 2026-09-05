//! Typed, serializable error surface shared by every command.
//!
//! Commands return `AppResult<T>`; Tauri serializes the error into the IPC
//! rejection payload, so the message must be safe and useful to show a user.

use serde::{Serialize, Serializer};

/// Every failure that can cross the IPC boundary.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),

    #[error("parse error: {0}")]
    Parse(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("archive error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("{0}")]
    Message(String),
}

impl AppError {
    /// Lock poisoning and other unrecoverable process-state failures.
    pub fn poisoned(what: &str) -> Self {
        AppError::Message(format!("内部状态损坏：{what} 的锁已被污染"))
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Result alias used by all command handlers.
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_are_tagged() {
        let err =
            AppError::from(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked"));
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().starts_with("io error:"));
    }

    #[test]
    fn serializes_as_plain_message() {
        let json = serde_json::to_string(&AppError::NotFound("book".into()))
            .expect("serialization must not fail");
        assert_eq!(json, "\"not found: book\"");
    }

    #[test]
    fn every_variant_renders_a_showable_sentence() {
        for err in [
            AppError::UnsupportedFormat("pdf".into()),
            AppError::Parse("bad opf".into()),
            AppError::InvalidArgument("empty id".into()),
            AppError::poisoned("library"),
        ] {
            assert!(!err.to_string().is_empty(), "{err:?} rendered nothing");
        }
    }
}
