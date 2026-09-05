//! OpenAI-compatible `/embeddings` client.
//!
//! The same endpoint style as `chat.rs` — one wire shape covers hosted APIs
//! and local servers (Ollama, LM Studio). Unlike chat there is no streaming:
//! a batch comes back as one JSON body, which is exactly what indexing wants.

use serde::Deserialize;

use crate::error::{AppError, AppResult};

/// Batch size for indexing. Big enough to amortize round trips, small enough
/// that one bad batch costs little and the progress event keeps moving.
pub const BATCH: usize = 16;

/// Embeds every text, preserving order. A batch that the provider rejects
/// fails the whole call — the caller decides whether to continue indexing.
pub async fn embed(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    texts: &[String],
) -> AppResult<Vec<Vec<f32>>> {
    debug_assert!(!texts.is_empty());
    let url = format!("{base_url}/embeddings");
    let mut request =
        client.post(&url).json(&serde_json::json!({ "model": model, "input": texts }));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|err| AppError::Message(format!("无法连接 embedding 接口：{err}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| AppError::Message(format!("读取 embedding 响应失败：{err}")))?;
    if !status.is_success() {
        return Err(super::chat::provider_error(status.as_u16(), &body));
    }

    let parsed: EmbeddingResponse = serde_json::from_str(&body)
        .map_err(|err| AppError::Message(format!("embedding 响应无法解析：{err}")))?;
    let mut vectors: Vec<Option<Vec<f32>>> = vec![None; texts.len()];
    for item in parsed.data {
        if item.index < texts.len() {
            vectors[item.index] = Some(item.embedding);
        }
    }
    // A missing slot means the provider dropped an input; treating that as an
    // error is safer than silently indexing a gap.
    vectors
        .into_iter()
        .enumerate()
        .map(|(index, vector)| {
            vector.ok_or_else(|| {
                AppError::Message(format!("embedding 响应缺少第 {index} 条输入的向量"))
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Deserialize)]
struct EmbeddingItem {
    index: usize,
    embedding: Vec<f32>,
}

/// L2-normalizes in place; `None` for a zero vector, which has no direction.
pub fn normalize(vector: &mut [f32]) -> Option<()> {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return None;
    }
    for value in vector {
        *value /= norm;
    }
    Some(())
}

/// Dot product of two equal-length vectors. Inputs are expected normalized, so
/// this is cosine similarity without the division.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// f32 slice ↔ little-endian bytes, for the `chunks.embedding` BLOB.
pub fn to_bytes(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// Inverse of [`to_bytes`]; `None` when the byte length is not a whole number
/// of `f32`s (a schema from a different world).
pub fn from_bytes(bytes: &[u8]) -> Option<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    Some(bytes.as_chunks::<4>().0.iter().map(|chunk| f32::from_le_bytes(*chunk)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_vectors_have_unit_length() {
        let mut vector = vec![3.0, 4.0];
        normalize(&mut vector).expect("normalize");
        assert!((dot(&vector, &vector) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_zero_vector_has_no_direction() {
        let mut vector = vec![0.0, 0.0];
        assert!(normalize(&mut vector).is_none());
    }

    #[test]
    fn similar_directions_score_higher_than_orthogonal() {
        let mut a = vec![1.0, 1.0];
        let mut b = vec![2.0, 2.0];
        let mut c = vec![-1.0, 1.0];
        normalize(&mut a).expect("a");
        normalize(&mut b).expect("b");
        normalize(&mut c).expect("c");
        assert!(dot(&a, &b) > 0.99, "同向必须高分");
        assert!(dot(&a, &c).abs() < 1e-6, "正交必须接近零");
    }

    #[test]
    fn bytes_round_trip() {
        let vector = vec![0.25, -1.5, 7.0];
        let decoded = from_bytes(&to_bytes(&vector)).expect("decode");
        assert_eq!(decoded, vector);
        assert!(from_bytes(&[1, 2, 3]).is_none(), "半截字节必须被拒绝");
    }
}
