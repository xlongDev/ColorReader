//! Reading the text back out of a page image, through the same
//! OpenAI-compatible endpoint everything else already speaks.
//!
//! The problem this solves is narrow and real: a scanned PDF has no text layer,
//! so this reader cannot search it, read it aloud, or be asked about it. A
//! vision-capable model turns that page back into the chapter corpus the rest
//! of the pipeline already speaks — no bundled dataset, no native OCR engine,
//! and a model running on the reader's own machine stays on their own machine.
//!
//! What it does **not** bring back is the text layer. Selecting a phrase needs
//! per-glyph positions, and a vision model answers with words, not boxes. So a
//! recognised page joins search, read-aloud, RAG and the assistant, and stays
//! unselectable — exactly as it was. Recovering selection means handing back
//! coordinates, which is a different job and a different model.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// What the model is asked for. A scanned page is usually a few hundred words,
/// and every token spent explaining the task is one not spent on the text.
///
/// Chinese, because the books this reader is used on are, and a model follows
/// an instruction in the language it is being addressed in.
const INSTRUCTION: &str = "把这一页的正文逐字转录为纯文本。保留自然段之间的换行，不要翻译、不要解释、不要补充原图没有的内容。";

/// Refuses a data URL that is obviously not a page image. A page at the size
/// this reader rasterises is well under a megabyte; anything an order of
/// magnitude past that is a mistake, and forwarding it would bill the reader
/// for the upload before the provider ever says no.
const MAX_DATA_URL_BYTES: usize = 8 * 1024 * 1024;

/// One request, non-streaming: a page is one answer, so there is nothing for
/// an event stream to carry.
#[derive(Debug, Serialize)]
struct VisionRequest<'a> {
    model: &'a str,
    messages: Vec<VisionMessage<'a>>,
    max_tokens: u32,
    /// Transcription is not creative writing; the provider's own default is
    /// usually higher than it should be here.
    temperature: f32,
}

#[derive(Debug, Serialize)]
struct VisionMessage<'a> {
    role: &'a str,
    /// A message whose content is a list of parts, per the vision shape. The
    /// plain-string form is not expressible here — providers that only speak
    /// the string form would need the other half of this enum, and none of the
    /// ones worth supporting do.
    content: Vec<Part<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Part<'a> {
    Text { text: &'a str },
    ImageUrl { image_url: ImageRef<'a> },
}

#[derive(Debug, Serialize)]
struct ImageRef<'a> {
    url: &'a str,
}

/// A page worth sending. The provider takes the whole data URL, so nothing
/// here decodes base64 — only checks it is what it claims to be.
pub fn check_image(data_url: &str) -> AppResult<()> {
    if data_url.len() > MAX_DATA_URL_BYTES {
        return Err(AppError::InvalidArgument("这一页的图片太大了，先缩小再识别".into()));
    }
    let rest = data_url
        .strip_prefix("data:image/")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or_else(|| {
            AppError::InvalidArgument("传进来的不是一张图片（需要 base64 的 data URL）".into())
        })?;
    if rest.1.is_empty() {
        return Err(AppError::InvalidArgument("图片是空的".into()));
    }
    Ok(())
}

/// Sends one page and returns what the model read off it.
pub async fn transcribe(
    client: &reqwest::Client,
    config: &super::AiConfig,
    image_data_url: &str,
) -> AppResult<String> {
    check_image(image_data_url)?;
    let body = VisionRequest {
        model: &config.model,
        messages: vec![VisionMessage {
            role: "user",
            content: vec![
                Part::Text { text: INSTRUCTION },
                Part::ImageUrl { image_url: ImageRef { url: image_data_url } },
            ],
        }],
        max_tokens: 4000,
        temperature: 0.0,
    };

    let mut request = client.post(super::completions_url(&config.base_url)).json(&body);
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|err| AppError::Message(format!("连接 AI 端点失败：{err}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // The provider usually names the actual problem ("model does not
        // support image input"), and swallowing that leaves people guessing.
        return Err(AppError::Message(format!(
            "AI 端点拒绝了这一页（{}）：{}",
            status.as_u16(),
            text.chars().take(200).collect::<String>()
        )));
    }
    reply(&text)
}

/// Pulls the answer out of a non-streaming response.
///
/// A pure function over the body so it can be tested without a socket — which
/// is the only part with real branching here.
fn reply(body: &str) -> AppResult<String> {
    let parsed: Reply = serde_json::from_str(body)
        .map_err(|err| AppError::Message(format!("AI 的回答不是合法 JSON：{err}")))?;
    let text = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .map(|content| normalise(&content))
        .ok_or_else(|| AppError::Message("AI 没有返回识别结果".into()))?;
    if text.is_empty() {
        return Err(AppError::Message("这一页没有识别出文字，可能不是扫描页".into()));
    }
    Ok(text)
}

#[derive(Debug, Deserialize)]
struct Reply {
    #[serde(default)]
    choices: Vec<ReplyChoice>,
}

#[derive(Debug, Deserialize)]
struct ReplyChoice {
    #[serde(default)]
    message: ReplyMessage,
}

#[derive(Debug, Default, Deserialize)]
struct ReplyMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Turns a model's answer into the one paragraph-per-line shape `chapters`
/// stores, and strips the fences it sometimes wraps plain text in.
fn normalise(raw: &str) -> String {
    let trimmed = raw.trim();
    let body = trimmed
        .strip_prefix("```")
        .and_then(|rest| rest.strip_suffix("```"))
        .unwrap_or(trimmed)
        .trim_start_matches(|c: char| c.is_ascii_alphabetic() || c == '\n')
        .trim();
    body.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_is_read_out_of_the_response() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"第一章\n\n他推开门。"},"finish_reason":"stop"}]}"#;
        assert_eq!(reply(body).expect("reply"), "第一章\n他推开门。");
    }

    #[test]
    fn a_fenced_answer_is_unwrapped() {
        // Models wrap plain text in a fence even when told not to; leaving the
        // backticks in would put them into the search index.
        let body = r#"{"choices":[{"message":{"content":"```\n正文第一段。\n```"}}]}"#;
        assert_eq!(reply(body).expect("reply"), "正文第一段。");
    }

    #[test]
    fn an_empty_page_is_a_sentence_rather_than_an_empty_string() {
        // A blank scan is not an error the reader can act on by being handed "".
        let body = r#"{"choices":[{"message":{"content":"   \n  "}}]}"#;
        let err = reply(body).expect_err("blank");
        assert!(err.to_string().contains("没有识别出文字"), "{err}");
    }

    #[test]
    fn a_provider_that_answers_something_else_is_reported_as_one() {
        let err = reply(r#"{"error":{"message":"model does not support image input"}}"#)
            .expect_err("no choices");
        assert!(err.to_string().contains("没有返回识别结果"), "{err}");
    }

    #[test]
    fn only_a_base64_image_is_accepted() {
        assert!(check_image("data:image/jpeg;base64,/9j/4AAQ").is_ok());
        assert!(check_image("https://example.com/page.jpg").is_err());
        assert!(check_image("data:text/plain;base64,aGk=").is_err());
        assert!(check_image("data:image/jpeg;base64,").is_err());
        assert!(check_image(&format!("data:image/png;base64,{}", "a".repeat(9_000_000))).is_err());
    }
}
