//! Cohere-compatible `/rerank` client.
//!
//! Reranking has no OpenAI standard, but the Cohere wire shape became the de
//! facto one: Jina, SiliconFlow and friends all accept `POST {base}/rerank`
//! with `{model, query, documents, top_n}` and reply
//! `{"results": [{"index", "relevance_score"}]}`. Reusing the configured base
//! URL keeps the settings page at one endpoint. An empty `rerank_model` in the
//! config disables the call entirely — reranking is an enhancement, not a
//! prerequisite.

use serde::Deserialize;

use crate::error::{AppError, AppResult};

/// Reranks `documents` against `query`, returning document indices ordered by
/// descending relevance, capped at `top_n`.
pub async fn rerank(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    query: &str,
    documents: &[String],
    top_n: usize,
) -> AppResult<Vec<usize>> {
    let url = format!("{base_url}/rerank");
    let mut request = client.post(&url).json(&serde_json::json!({
        "model": model,
        "query": query,
        "documents": documents,
        "top_n": top_n,
    }));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|err| AppError::Message(format!("无法连接重排接口：{err}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| AppError::Message(format!("读取重排响应失败：{err}")))?;
    if !status.is_success() {
        return Err(super::chat::provider_error(status.as_u16(), &body));
    }

    ordered_indices(&body, documents.len())
        .map(|indices| indices.into_iter().take(top_n).collect())
        .ok_or_else(|| AppError::Message("重排响应无法解析".into()))
}

/// Parses a rerank response into document indices, best first. Out-of-range
/// indices are dropped rather than trusted — a provider bug must not panic the
/// caller indexing `hits[i]`.
fn ordered_indices(body: &str, documents_len: usize) -> Option<Vec<usize>> {
    let parsed: RerankResponse = serde_json::from_str(body).ok()?;
    let mut results: Vec<RerankResult> =
        parsed.results.into_iter().filter(|item| item.index < documents_len).collect();
    results.sort_by(|a, b| {
        b.relevance_score.partial_cmp(&a.relevance_score).unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(results.into_iter().map(|item| item.index).collect())
}

#[derive(Deserialize)]
struct RerankResponse {
    #[serde(default)]
    results: Vec<RerankResult>,
}

#[derive(Deserialize)]
struct RerankResult {
    index: usize,
    #[serde(default)]
    relevance_score: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_are_ordered_by_descending_score() {
        let body = r#"{"results":[
            {"index":0,"relevance_score":0.4},
            {"index":2,"relevance_score":0.9},
            {"index":1,"relevance_score":0.7}]}"#;
        assert_eq!(ordered_indices(body, 3), Some(vec![2, 1, 0]));
    }

    #[test]
    fn out_of_range_indices_are_dropped() {
        let body = r#"{"results":[
            {"index":1,"relevance_score":0.5},
            {"index":9,"relevance_score":0.99}]}"#;
        assert_eq!(ordered_indices(body, 2), Some(vec![1]));
    }

    #[test]
    fn a_missing_results_field_yields_an_empty_order() {
        assert_eq!(ordered_indices("{}", 3), Some(Vec::new()));
    }

    #[test]
    fn an_unparseable_body_is_none() {
        assert_eq!(ordered_indices("not json", 3), None);
    }

    #[test]
    fn a_missing_score_sorts_last() {
        let body = r#"{"results":[
            {"index":0},
            {"index":1,"relevance_score":0.1}]}"#;
        assert_eq!(ordered_indices(body, 2), Some(vec![1, 0]));
    }
}
