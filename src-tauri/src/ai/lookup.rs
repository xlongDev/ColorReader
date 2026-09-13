//! DeepL translation and Wikipedia lookup: the two external services the
//! selection toolbar calls directly. Neither speaks the OpenAI wire format,
//! so they live beside — not inside — the chat stack. Both are one-shot HTTP
//! calls from the backend: keys never reach the renderer, and CORS never
//! applies to the webview.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Wikipedia asks API clients to identify themselves.
const WIKI_USER_AGENT: &str = concat!(
    "ColorReader/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/xlongDev/ColorReader)"
);

/// How many characters of a selection are used as the Wikipedia lookup key.
/// A whole selected sentence still finds its article via the search fallback;
/// anything past this cap is noise for the URL.
const WIKI_TERM_CAP: usize = 80;

/// DeepL API host, chosen by key shape: free-tier auth keys end in `:fx` and
/// only resolve on the `api-free` host — the paid host rejects them, and vice
/// versa, with a confusing 403.
pub fn deepl_endpoint(key: &str) -> &'static str {
    if key.trim_end().ends_with(":fx") {
        "https://api-free.deepl.com"
    } else {
        "https://api.deepl.com"
    }
}

/// DeepL target language for a passage: CJK-heavy text goes to English,
/// everything else to Simplified Chinese. Depth of the CJK range check does
/// not matter — anything CJK enough to read as "the source language" matches
/// the first range.
pub fn deepl_target(text: &str) -> &'static str {
    let cjk = text.chars().filter(|c| matches!(c, '\u{4E00}'..='\u{9FFF}')).count();
    let letters = text.chars().filter(|c| c.is_alphabetic()).count().max(1);
    if cjk * 2 > letters { "EN" } else { "ZH" }
}

/// Which Wikipedia editions to try, in order: the reader's language first,
/// English as the fallback for terms the home wiki does not have.
pub fn wiki_langs(text: &str) -> &'static [&'static str] {
    if text.chars().any(|c| matches!(c, '\u{4E00}'..='\u{9FFF}')) { &["zh", "en"] } else { &["en"] }
}

/// One DeepL translation: the rendered text plus what DeepL thought the
/// source was, shown as a small tag in the popup.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Translation {
    pub text: String,
    pub detected_lang: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeeplResponse {
    translations: Vec<DeeplTranslation>,
}

#[derive(Debug, Deserialize)]
struct DeeplTranslation {
    #[serde(rename = "detected_source_language")]
    detected_source_language: Option<String>,
    text: String,
}

/// Translates one passage with DeepL. The key is validated only by the API:
/// any non-empty string is worth a round trip, and the status code tells the
/// reader whether the key or the quota is the problem.
pub async fn deepl_translate(
    client: &reqwest::Client,
    key: &str,
    text: &str,
) -> AppResult<Translation> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::InvalidArgument(
            "先在设置里填写 DeepL API Key，或留空使用 AI 翻译".into(),
        ));
    }
    let passage: String = text.chars().take(5000).collect();
    let response = client
        .post(format!("{}/v2/translate", deepl_endpoint(key)))
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .json(&serde_json::json!({ "text": [passage], "target_lang": deepl_target(&passage) }))
        .send()
        .await
        .map_err(|err| AppError::Message(format!("DeepL 连接失败：{err}")))?;

    let status = response.status();
    if !status.is_success() {
        // DeepL's error codes are stable and specific; surface the one that
        // matters instead of a wall of response body.
        let hint = match status.as_u16() {
            401 | 403 => "，请检查 Key 是否有效",
            456 => "，本月免费额度已用完",
            429 => "，请求太频繁，稍后再试",
            _ => "",
        };
        return Err(AppError::Message(format!("DeepL 翻译失败（{status}）{hint}")));
    }

    let parsed: DeeplResponse = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("DeepL 返回了无法解析的内容：{err}")))?;
    let first = parsed
        .translations
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Message("DeepL 返回了空结果".into()))?;
    Ok(Translation { text: first.text, detected_lang: first.detected_source_language })
}

/// A Wikipedia article summary, ready to render in the lookup popup.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSummary {
    pub title: String,
    pub extract: String,
    pub thumbnail: Option<String>,
    pub page_url: String,
    pub lang: String,
}

#[derive(Debug, Deserialize)]
struct WikiRestSummary {
    title: String,
    extract: String,
    thumbnail: Option<WikiThumbnail>,
    #[serde(default)]
    content_urls: Option<WikiContentUrls>,
}

#[derive(Debug, Deserialize)]
struct WikiThumbnail {
    source: String,
}

#[derive(Debug, Deserialize)]
struct WikiContentUrls {
    desktop: WikiDesktopUrl,
}

#[derive(Debug, Deserialize)]
struct WikiDesktopUrl {
    page: String,
}

#[derive(Debug, Deserialize)]
struct WikiSearchResponse {
    pages: Vec<WikiSearchPage>,
}

#[derive(Debug, Deserialize)]
struct WikiSearchPage {
    key: String,
}

/// The best-matching article summary for a term: exact title first, then the
/// edition's search index, then the next edition in [`wiki_langs`]. No match
/// anywhere is a `NotFound`, which the popup shows as plain text.
pub async fn wikipedia_summary(client: &reqwest::Client, term: &str) -> AppResult<WikiSummary> {
    let term = term.trim();
    if term.is_empty() {
        return Err(AppError::InvalidArgument("没有要查询的词条".into()));
    }
    let term: String = term.chars().take(WIKI_TERM_CAP).collect();

    for lang in wiki_langs(&term) {
        // Exact title, following redirects (`柏拉图` → the real article).
        if let Some(summary) = fetch_summary(client, &term, lang).await? {
            return Ok(summary);
        }
        // Search fallback: the selection is rarely a canonical title.
        if let Some(key) = search_first_key(client, &term, lang).await?
            && let Some(summary) = fetch_summary(client, &key, lang).await?
        {
            return Ok(summary);
        }
    }
    Err(AppError::NotFound("维基百科没有找到这个词条".into()))
}

/// Fetches `/page/summary/{key}`; `Ok(None)` means "no such page here", so the
/// caller moves on to the search fallback or the next edition. Any other
/// failure is a hard error.
async fn fetch_summary(
    client: &reqwest::Client,
    key: &str,
    lang: &str,
) -> AppResult<Option<WikiSummary>> {
    let mut url =
        reqwest::Url::parse(&format!("https://{lang}.wikipedia.org/api/rest_v1/page/summary/"))
            .map_err(|err| AppError::Message(format!("URL 解析失败：{err}")))?;
    // Path-segment encoding, not a query string: the summary API takes the
    // title as a path piece, and `Url` percent-encodes CJK and spaces for us.
    url.path_segments_mut().map_err(|_| AppError::Message("URL 解析失败".into()))?.push(key);
    url.set_query(Some("redirect=true"));

    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, WIKI_USER_AGENT)
        .send()
        .await
        .map_err(|err| AppError::Message(format!("维基百科连接失败：{err}")))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(AppError::Message(format!("维基百科请求失败（{}）", response.status())));
    }
    let page: WikiRestSummary = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("维基百科返回了无法解析的内容：{err}")))?;
    Ok(Some(WikiSummary {
        title: page.title,
        extract: page.extract,
        thumbnail: page.thumbnail.map(|t| t.source),
        page_url: page
            .content_urls
            .map(|c| c.desktop.page)
            .unwrap_or_else(|| format!("https://{lang}.wikipedia.org/wiki/{}", key)),
        lang: lang.to_string(),
    }))
}

/// The first hit of the edition's search index, or `None` when it has none.
async fn search_first_key(
    client: &reqwest::Client,
    term: &str,
    lang: &str,
) -> AppResult<Option<String>> {
    let response = client
        .get(format!("https://{lang}.wikipedia.org/w/rest.php/v1/search/page"))
        .query(&[("q", term), ("limit", "1")])
        .header(reqwest::header::USER_AGENT, WIKI_USER_AGENT)
        .send()
        .await
        .map_err(|err| AppError::Message(format!("维基百科连接失败：{err}")))?;
    if !response.status().is_success() {
        // A failing search index is not fatal: the exact-title lookup may
        // already have succeeded, and the next edition may still work.
        return Ok(None);
    }
    let parsed: WikiSearchResponse = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("维基百科搜索返回了无法解析的内容：{err}")))?;
    Ok(parsed.pages.into_iter().next().map(|page| page.key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_shape_chooses_the_deepl_host() {
        assert_eq!(deepl_endpoint("abc123:fx"), "https://api-free.deepl.com");
        assert_eq!(deepl_endpoint("abc123:fx  "), "https://api-free.deepl.com", "尾随空白不影响");
        assert_eq!(deepl_endpoint("abc123"), "https://api.deepl.com");
    }

    #[test]
    fn chinese_goes_to_english_and_the_other_way_round() {
        assert_eq!(deepl_target("hello world"), "ZH");
        assert_eq!(deepl_target("你好，世界"), "EN");
        assert_eq!(deepl_target("这是一本关于 Rust 的书。"), "EN", "夹几个英文词不改判");
        assert_eq!(deepl_target("a book about 阅读"), "ZH", "英文为主仍译成中文");
    }

    #[test]
    fn the_wiki_edition_follows_the_script() {
        assert_eq!(wiki_langs("柏拉图"), &["zh", "en"]);
        assert_eq!(wiki_langs("ChatGPT"), &["en"]);
    }
}
