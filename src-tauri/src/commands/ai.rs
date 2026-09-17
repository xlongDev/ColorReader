//! `ai.*` commands: configuration and streaming chat.
//!
//! Chat runs entirely on the Rust side and pushes deltas out as events, so a
//! long answer never blocks the UI thread and never waits for a full response
//! body to arrive.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai::chat::{self, ChatMessage, Role, StreamEvent};
use crate::ai::{AiConfig, is_ready};
use crate::error::{AppError, AppResult};
use crate::library::guide;
use crate::state::AppState;

/// Streamed chunks for one request.
pub const AI_STREAM_EVENT: &str = "ai://stream";

/// Said whenever a command needs a model that has not been configured yet.
pub(crate) const NOT_CONFIGURED: &str = "还没有配置 AI 模型，先到设置里填写接口地址与模型名称";

/// Connect and per-read timeouts.
///
/// A local model can take tens of seconds to load its weights on the first
/// request, so the read timeout is generous; the connect timeout is not, because
/// a refused connection is known within milliseconds.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// One chunk of a streamed answer.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDelta {
    /// Echoed back so a reopened panel can ignore a stream it no longer owns.
    pub request_id: String,
    /// Present on incremental text.
    pub text: Option<String>,
    /// Set on the final event; `null` while streaming.
    pub done: bool,
    /// Provider's stop reason when it reports one.
    pub finish_reason: Option<String>,
    /// Set only on the final event when the stream failed.
    pub error: Option<String>,
    /// RAG sources, present on the final event of a retrieval-backed answer.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub citations: Vec<crate::library::rag::RagHit>,
}

/// `ai.getConfig`
#[tauri::command]
#[specta::specta]
pub fn ai_get_config(state: State<'_, AppState>) -> AppResult<AiConfig> {
    crate::ai::config(&state.library)
}

/// `ai.setConfig`
#[tauri::command]
#[specta::specta]
pub fn ai_set_config(state: State<'_, AppState>, config: AiConfig) -> AppResult<AiConfig> {
    crate::ai::set_config(&state.library, &config)?;
    // Return the stored form: the caller trimmed and normalized it, and the UI
    // should show what is actually persisted rather than what it typed.
    crate::ai::config(&state.library)
}

/// `ai.test` — proves endpoint, key and model name work *together*.
///
/// Deliberately does not save: pressing "测试连接" must not persist a half-typed
/// key. The UI saves explicitly.
#[tauri::command]
#[specta::specta]
pub async fn ai_test(config: AiConfig) -> AppResult<()> {
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument("先填写接口地址与模型名称".into()));
    }
    // Validate the shape locally first: a malformed URL should not need a round
    // trip to be reported.
    let checked = AiConfig {
        base_url: crate::ai::normalize_base_url(&config.base_url)?,
        model: config.model.trim().to_string(),
        api_key: config.api_key.trim().to_string(),
        system_prompt: config.system_prompt,
        embedding_model: config.embedding_model,
        rerank_model: config.rerank_model,
        deepl_key: config.deepl_key,
    };
    if checked.model.is_empty() {
        return Err(AppError::InvalidArgument("模型名称不能为空".into()));
    }
    chat::probe(&client()?, &checked).await
}

/// `ai.chat` — streams an answer to [`AI_STREAM_EVENT`].
///
/// Returns as soon as the request is accepted; the answer arrives as a series
/// of events and is terminated by one with `done: true`, which also carries
/// `error` when the stream failed part way through.
#[tauri::command]
#[specta::specta]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    messages: Vec<ChatMessage>,
) -> AppResult<()> {
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }
    if messages.is_empty() {
        return Err(AppError::InvalidArgument("没有要发送的内容".into()));
    }

    let result = run_stream(&app, &request_id, &config, messages, Vec::new()).await;
    if let Err(err) = result {
        emit(
            &app,
            AiDelta {
                request_id: request_id.clone(),
                text: None,
                done: true,
                finish_reason: None,
                error: Some(err.to_string()),
                citations: Vec::new(),
            },
        );
        return Err(err);
    }
    Ok(())
}

/// Streams one answer to [`AI_STREAM_EVENT`], attaching `citations` to the
/// final event. Shared by plain chat, RAG-backed chat and the reading guide.
///
/// Returns the assembled answer: callers that cache it (the guide) need the
/// whole text, and the one that streams it to a reader ignores the value.
pub(crate) async fn run_stream(
    app: &AppHandle,
    request_id: &str,
    config: &AiConfig,
    messages: Vec<ChatMessage>,
    citations: Vec<crate::library::rag::RagHit>,
) -> AppResult<String> {
    let client = client()?;
    let mut full = String::new();
    let mut finished = false;

    chat::stream_chat(&client, config, with_system(config, messages), &mut |event| {
        if matches!(event, StreamEvent::Done) {
            finished = true;
        }
        let delta = match event {
            StreamEvent::Delta(text) => {
                full.push_str(&text);
                AiDelta {
                    request_id: request_id.to_string(),
                    text: Some(text),
                    done: false,
                    finish_reason: None,
                    error: None,
                    citations: Vec::new(),
                }
            }
            StreamEvent::Finish(reason) => AiDelta {
                request_id: request_id.to_string(),
                text: None,
                done: false,
                finish_reason: reason,
                error: None,
                citations: Vec::new(),
            },
            StreamEvent::Done => AiDelta {
                request_id: request_id.to_string(),
                text: None,
                done: true,
                finish_reason: None,
                error: None,
                citations: citations.clone(),
            },
        };
        emit(app, delta);
    })
    .await?;

    // Some providers close the socket without a `[DONE]` frame once they have
    // sent a finish reason. The stream is over either way, so say so exactly
    // once.
    if !finished {
        emit(
            app,
            AiDelta {
                request_id: request_id.to_string(),
                text: None,
                done: true,
                finish_reason: None,
                error: None,
                citations,
            },
        );
    }
    tracing::info!(request_id, chars = full.chars().count(), "AI 回答完成");
    Ok(full)
}

/// `ai.digest` — streams a reading guide for one book.
///
/// The cache is consulted first, and a hit is replayed as a single delta: the
/// panel then has exactly one code path whether or not a guide already existed.
/// `refresh` skips the cache and writes a new one over the old.
///
/// Only a complete answer is cached. A stream that failed half way through is
/// left out, so the next open regenerates instead of showing the stump forever.
#[tauri::command]
#[specta::specta]
pub async fn ai_digest(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    book_id: String,
    refresh: bool,
) -> AppResult<()> {
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }

    if !refresh && let Some(cached) = state.library.with(|conn| guide::cached(conn, &book_id))? {
        replay(&app, &request_id, cached);
        return Ok(());
    }

    let material = state.library.with(|conn| guide::material(conn, &book_id))?;
    // The guide carries its own instructions, and `with_system` leaves a
    // conversation alone when it already opens with one: the reader's general
    // assistant prompt must not reshape this.
    let messages = vec![
        ChatMessage { role: Role::System, content: guide::PROMPT.to_string() },
        ChatMessage { role: Role::User, content: material },
    ];

    match run_stream(&app, &request_id, &config, messages, Vec::new()).await {
        Ok(text) => {
            // Not `guide`: that name is the module this writes through.
            let written = text.trim();
            if written.is_empty() {
                return Err(AppError::Message("模型没有返回内容".into()));
            }
            state.library.with(|conn| guide::store(conn, &book_id, written))?;
            Ok(())
        }
        Err(err) => {
            emit(
                &app,
                AiDelta {
                    request_id,
                    text: None,
                    done: true,
                    finish_reason: None,
                    error: Some(err.to_string()),
                    citations: Vec::new(),
                },
            );
            Err(err)
        }
    }
}

/// Emits a stored answer as "one delta, then done", which is what a stream that
/// arrived instantly looks like.
fn replay(app: &AppHandle, request_id: &str, text: String) {
    emit(
        app,
        AiDelta {
            request_id: request_id.to_string(),
            text: Some(text),
            done: false,
            finish_reason: None,
            error: None,
            citations: Vec::new(),
        },
    );
    emit(
        app,
        AiDelta {
            request_id: request_id.to_string(),
            text: None,
            done: true,
            finish_reason: None,
            error: None,
            citations: Vec::new(),
        },
    );
}

/// Prepends the configured system prompt, unless the caller already sent one.
pub(crate) fn with_system(config: &AiConfig, messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    if config.system_prompt.trim().is_empty()
        || messages.first().is_some_and(|first| first.role == Role::System)
    {
        return messages;
    }
    let mut all = Vec::with_capacity(messages.len() + 1);
    all.push(ChatMessage { role: Role::System, content: config.system_prompt.clone() });
    all.extend(messages);
    all
}

pub(crate) fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|err| AppError::Message(format!("无法创建 HTTP 客户端：{err}")))
}

pub(crate) fn emit(app: &AppHandle, delta: AiDelta) {
    // A closed window just stops listening; dropping the event is correct.
    let _ = app.emit(AI_STREAM_EVENT, delta);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stream_event_is_namespaced() {
        assert!(AI_STREAM_EVENT.starts_with("ai://"));
    }

    #[test]
    fn a_system_prompt_is_prepended_exactly_once() {
        let config = AiConfig { system_prompt: "S".into(), ..AiConfig::default() };
        let messages = vec![ChatMessage { role: Role::User, content: "Q".into() }];

        let with = with_system(&config, messages.clone());
        assert_eq!(with.len(), 2);
        assert_eq!(with[0].content, "S");

        // Already carrying one: leave it alone rather than doubling up.
        let mut already = vec![ChatMessage { role: Role::System, content: "mine".into() }];
        already.extend(messages);
        assert_eq!(with_system(&config, already).len(), 2);
    }

    #[test]
    fn an_empty_system_prompt_adds_nothing() {
        let config = AiConfig { system_prompt: "  ".into(), ..AiConfig::default() };
        let messages = vec![ChatMessage { role: Role::User, content: "Q".into() }];
        assert_eq!(with_system(&config, messages).len(), 1);
    }

    #[test]
    fn deltas_serialize_in_camel_case() {
        let value = serde_json::to_value(AiDelta {
            request_id: "r1".into(),
            text: Some("hi".into()),
            done: false,
            finish_reason: None,
            error: None,
            citations: Vec::new(),
        })
        .expect("serialize");
        assert_eq!(value["requestId"], "r1");
        assert_eq!(value["text"], "hi");
        assert_eq!(value["done"], serde_json::json!(false));
        assert!(value.get("citations").is_none(), "空引用不序列化");
    }
}
