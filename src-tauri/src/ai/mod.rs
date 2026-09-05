//! AI provider configuration.
//!
//! One shape covers both hosted and local models: Ollama, LM Studio, vLLM and
//! friends all speak the OpenAI `/v1/chat/completions` wire format, so "OpenAI
//! compatible" is not a vendor lock-in, it is the de facto protocol. Users point
//! `base_url` at whatever they run.
//!
//! The API key is stored in SQLite, never in the renderer: a key in a webview's
//! localStorage is readable by anything that can read the profile directory, and
//! the backend needs it anyway because the backend makes the call.

pub mod chat;
pub mod embeddings;
pub mod rerank;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Where chat completions are sent and how they are signed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// Origin only, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    /// Empty for local endpoints that need no key.
    pub api_key: String,
    pub model: String,
    /// Prepended to every conversation; keeps answers in the reader's voice.
    #[serde(default)]
    pub system_prompt: String,
    /// Embedding model for RAG. Empty disables library-wide retrieval; the chat
    /// assistant works without it. Same endpoint and key as chat.
    #[serde(default)]
    pub embedding_model: String,
    /// Reranker for retrieval, Cohere-compatible `/rerank`. Empty disables the
    /// second-stage ranking. Same endpoint and key as chat.
    #[serde(default)]
    pub rerank_model: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: String::new(),
            model: "gpt-4o-mini".to_string(),
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            embedding_model: String::new(),
            rerank_model: String::new(),
        }
    }
}

/// Answer in the book's own language, and say so when the passage does not
/// contain the answer. Without the last instruction models will happily invent
/// plot points, which is the one failure mode a reading assistant cannot have.
const DEFAULT_SYSTEM_PROMPT: &str = "你是一个阅读助手。只依据用户给出的原文回答问题；\
     原文没有提到的内容就说不知道，不要编造。回答使用原文所用的语言。";

const KEY: &str = "ai.config";

/// Persisted config, or the defaults when nothing has been saved yet.
pub fn config(library: &Library) -> AppResult<AiConfig> {
    library.with(|conn| {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |row| row.get(0))
            .optional()?;
        match stored {
            Some(json) => serde_json::from_str(&json)
                .map_err(|err| AppError::Message(format!("AI 配置已损坏，请重新填写：{err}"))),
            None => Ok(AiConfig::default()),
        }
    })
}

/// Writes the config back. `api_key` is validated by the caller's test call,
/// not here: any non-empty string is a syntactically valid key.
pub fn set_config(library: &Library, next: &AiConfig) -> AppResult<()> {
    let base = normalize_base_url(&next.base_url)?;
    let model = next.model.trim().to_string();
    if model.is_empty() {
        return Err(AppError::InvalidArgument("模型名称不能为空".into()));
    }

    let stored = AiConfig {
        base_url: base,
        api_key: next.api_key.trim().to_string(),
        model,
        system_prompt: next.system_prompt.clone(),
        embedding_model: next.embedding_model.trim().to_string(),
        rerank_model: next.rerank_model.trim().to_string(),
    };
    let json = serde_json::to_string(&stored)?;
    library.with(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                               updated_at = excluded.updated_at",
            rusqlite::params![KEY, json, crate::library::now_seconds()],
        )?;
        Ok(())
    })
}

/// `true` once a model is named: the endpoint may still be wrong, which is what
/// the test call is for.
pub fn is_ready(config: &AiConfig) -> bool {
    !config.model.trim().is_empty() && !config.base_url.trim().is_empty()
}

/// Trims whitespace and trailing slashes so path joining never produces `//v1`.
pub(crate) fn normalize_base_url(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::InvalidArgument("接口地址不能为空".into()));
    }
    // Local models are plain HTTP on loopback; anything else must be TLS, or the
    // key travels in clear text across a network the user does not control.
    let is_loopback_http = trimmed.starts_with("http://localhost")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://[::1]");
    if !trimmed.starts_with("https://") && !is_loopback_http {
        return Err(AppError::InvalidArgument(
            "接口地址必须是 https，本地模型可用 http://localhost".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// `…/chat/completions`, without duplicating a slash.
pub(crate) fn completions_url(base_url: &str) -> String {
    format!("{base_url}/chat/completions")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;

    struct Harness {
        dir: std::path::PathBuf,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&layout.data_dir).expect("open");
            Self { dir, library }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn an_unconfigured_library_gets_the_defaults() {
        let harness = Harness::new("ai-default");
        let config = config(&harness.library).expect("config");
        assert_eq!(config.base_url, "https://api.openai.com/v1");
        assert!(!config.system_prompt.is_empty());
        assert!(is_ready(&config));
    }

    #[test]
    fn a_saved_config_round_trips_without_its_key_leaking_elsewhere() {
        let harness = Harness::new("ai-roundtrip");
        set_config(
            &harness.library,
            &AiConfig {
                base_url: "http://localhost:11434/v1/".into(),
                api_key: " sk-secret ".into(),
                model: " qwen2.5 ".into(),
                system_prompt: "简短回答".into(),
                embedding_model: "nomic-embed-text".into(),
                rerank_model: " bge-reranker-v2-m3 ".into(),
            },
        )
        .expect("save");

        let config = config(&harness.library).expect("config");
        assert_eq!(config.base_url, "http://localhost:11434/v1", "斜杠与空白要去掉");
        assert_eq!(config.api_key, "sk-secret");
        assert_eq!(config.model, "qwen2.5");
        assert_eq!(config.system_prompt, "简短回答");
        assert_eq!(config.rerank_model, "bge-reranker-v2-m3");
    }

    #[test]
    fn saving_again_overwrites_rather_than_conflicting() {
        let harness = Harness::new("ai-overwrite");
        set_config(&harness.library, &AiConfig::default()).expect("first");
        set_config(&harness.library, &AiConfig { model: "other".into(), ..AiConfig::default() })
            .expect("second");
        assert_eq!(config(&harness.library).expect("config").model, "other");
    }

    #[test]
    fn a_model_name_is_required() {
        let harness = Harness::new("ai-no-model");
        let result =
            set_config(&harness.library, &AiConfig { model: "   ".into(), ..AiConfig::default() });
        assert!(matches!(result, Err(AppError::InvalidArgument(_))), "{result:?}");
    }

    #[test]
    fn clear_text_http_is_only_allowed_on_loopback() {
        assert!(normalize_base_url("http://localhost:11434/v1").is_ok());
        assert!(normalize_base_url("http://127.0.0.1:1234/v1").is_ok());
        assert!(normalize_base_url("http://example.com/v1").is_err(), "外网必须走 https");
        assert!(normalize_base_url("ftp://x").is_err());
        assert!(normalize_base_url("   ").is_err());
    }

    #[test]
    fn the_completions_path_is_joined_once() {
        assert_eq!(
            completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
    }
}
