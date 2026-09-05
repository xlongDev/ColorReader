//! `rag.*` commands: indexing, retrieval-backed chat and index status.
//!
//! Retrieval runs before the answer starts, so the model sees cited excerpts
//! and the UI can render the sources while the text streams in.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai::chat::{ChatMessage, Role};
use crate::ai::{self, embeddings};
use crate::error::{AppError, AppResult};
use crate::library::rag::{self, RagHit};
use crate::state::AppState;

/// With a reranker configured, first-stage recall is this many times wider
/// than the final cut before `/rerank` picks the best TOP_K.
const RECALL_MULTIPLIER: usize = 4;

/// Progress of one book's index build.
pub const RAG_INDEX_EVENT: &str = "rag://index-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagProgress {
    pub done: usize,
    pub total: usize,
}

/// Index status for one book and the library at large.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagStatus {
    /// Chunks stored for `book_id`.
    pub book_chunks: usize,
    /// Chunks stored across the whole library.
    pub library_chunks: usize,
    /// Empty when retrieval is not configured.
    pub embedding_model: String,
}

/// `rag.status` — what the AI drawer needs to decide which controls to show.
#[tauri::command]
pub fn rag_status(state: State<'_, AppState>, book_id: String) -> AppResult<RagStatus> {
    let (book_chunks, library_chunks) = state.library.with(|conn| rag::counts(conn, &book_id))?;
    let embedding_model = ai::config(&state.library)?.embedding_model;
    Ok(RagStatus { book_chunks, library_chunks, embedding_model })
}

/// `rag.indexBook` — rebuilds the embedding index for one book.
#[tauri::command]
pub async fn rag_index_book(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> AppResult<usize> {
    let config = ai::config(&state.library)?;
    let client = super::ai::client()?;
    let library = state.library.clone();

    let chunks = rag::reindex(&library, &client, &config, &book_id, &|done, total| {
        // A closed window just stops listening; dropping the event is correct.
        let _ = app.emit(RAG_INDEX_EVENT, RagProgress { done, total });
    })
    .await;
    match chunks {
        Ok(count) => {
            let _ = app.emit(RAG_INDEX_EVENT, RagProgress { done: count, total: count });
            Ok(count)
        }
        Err(err) => Err(err),
    }
}

/// `rag.chat` — retrieval-backed answer: embed the question, take the top
/// chunks, then stream an answer that cites them.
#[tauri::command]
pub async fn rag_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    question: String,
    book_id: Option<String>,
) -> AppResult<()> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::InvalidArgument("没有要发送的内容".into()));
    }
    let config = ai::config(&state.library)?;
    if !ai::is_ready(&config) {
        return Err(AppError::InvalidArgument(
            "还没有配置 AI 模型，先到设置里填写接口地址与模型名称".into(),
        ));
    }
    if config.embedding_model.trim().is_empty() {
        return Err(AppError::InvalidArgument("先到设置里填写向量模型，才能全书检索问答".into()));
    }

    // Question and chunks must come from the same embedding space.
    let client = super::ai::client()?;
    let mut query = embeddings::embed(
        &client,
        &config.base_url,
        &config.api_key,
        config.embedding_model.trim(),
        std::slice::from_ref(&question),
    )
    .await?
    .pop()
    .ok_or_else(|| AppError::Message("embedding 响应为空".into()))?;
    embeddings::normalize(&mut query)
        .ok_or_else(|| AppError::Message("模型返回了零向量".into()))?;

    // A configured reranker widens the first-stage recall, then cuts back to
    // TOP_K by relevance; without one the embedding order is final.
    let rerank_model = config.rerank_model.trim().to_string();
    let candidate_k =
        if rerank_model.is_empty() { rag::TOP_K } else { rag::TOP_K * RECALL_MULTIPLIER };
    let model = config.embedding_model.trim().to_string();
    let mut hits: Vec<RagHit> = state
        .library
        .with(|conn| rag::search(conn, &model, &query, book_id.as_deref(), candidate_k))?;
    if hits.is_empty() {
        return Err(AppError::InvalidArgument(
            "还没有可检索的索引，先在 AI 助手里点「索引本书」".into(),
        ));
    }

    if !rerank_model.is_empty() {
        let documents: Vec<String> = hits.iter().map(|hit| hit.text.clone()).collect();
        let order = crate::ai::rerank::rerank(
            &client,
            &config.base_url,
            &config.api_key,
            &rerank_model,
            &question,
            &documents,
            rag::TOP_K,
        )
        .await?;
        if order.is_empty() {
            return Err(AppError::Message("重排模型没有返回结果，检查重排模型名称".into()));
        }
        hits = order.into_iter().filter_map(|index| hits.get(index).cloned()).collect();
    }

    let messages = vec![ChatMessage { role: Role::User, content: build_prompt(&question, &hits) }];
    super::ai::run_stream(&app, &request_id, &config, messages, hits).await
}

/// Builds the retrieval prompt. Sources are numbered so the model can refer to
/// them and the UI's citation list lines up with what it saw.
fn build_prompt(question: &str, hits: &[RagHit]) -> String {
    let mut context = String::new();
    for (index, hit) in hits.iter().enumerate() {
        context.push_str(&format!(
            "[{}] 《{}》第 {} 章\n{}\n\n",
            index + 1,
            hit.book_title,
            hit.chapter_idx + 1,
            hit.text
        ));
    }
    format!(
        "根据下面的检索片段回答问题。片段之外的内容不要使用；片段不足以回答时直说。\n\n{context}问题：{question}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_event_is_namespaced() {
        assert!(RAG_INDEX_EVENT.starts_with("rag://"));
    }

    #[test]
    fn the_prompt_numbers_its_sources() {
        let hit = |title: &str, chapter: usize| RagHit {
            book_id: "b".into(),
            book_title: title.into(),
            chapter_idx: chapter,
            start_char: 0,
            score: 0.9,
            text: "片段".into(),
        };
        let prompt = build_prompt("主角是谁？", &[hit("书", 2), hit("另一本", 0)]);
        assert!(prompt.contains("[1] 《书》第 3 章"), "{prompt}");
        assert!(prompt.contains("[2] 《另一本》第 1 章"), "{prompt}");
        assert!(prompt.ends_with("问题：主角是谁？"));
    }
}
