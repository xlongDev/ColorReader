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
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
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
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
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
/// edition's search index — but only a result that is *about* the term (see
/// [`title_matches_term`]) — then the next edition in [`wiki_langs`]. No match
/// anywhere is a `NotFound`, which the popup shows as plain text.
pub async fn wikipedia_summary(client: &reqwest::Client, term: &str) -> AppResult<WikiSummary> {
    let term = term.trim();
    if term.is_empty() {
        return Err(AppError::InvalidArgument("没有要查询的词条".into()));
    }
    let term: String = term.chars().take(WIKI_TERM_CAP).collect();

    for lang in wiki_langs(&term) {
        // Exact title, following redirects (`柏拉图` → the real article, and a
        // simplified title → its traditional one, which is how 解释 reaches 解釋).
        if let Some(summary) = fetch_summary(client, &term, lang).await? {
            return Ok(summary);
        }
        // Search fallback: the selection is rarely a canonical title.
        if let Some(key) = search_matching_key(client, &term, lang).await?
            && let Some(summary) = fetch_summary(client, &key, lang).await?
        {
            return Ok(summary);
        }
    }
    Err(AppError::NotFound("维基百科没有找到这个词条".into()))
}

/// Whether a search hit is the term, or about it.
///
/// The search index ranks by *characters*, not by words: asking it for 阐释
/// (an ordinary word with no article at all) returns 範鑄法, 曾侯乙墓, 耶稣 —
/// entries that merely share one rare glyph. Presenting the first of those as
/// the definition is worse than saying nothing, so a hit is only taken when its
/// title *is* the term or holds it: equal after normalisation, or one inside
/// the other with at least two characters on the short side. That is the shape
/// a real near-miss takes (`Rust` → `Rust (programming language)`), and it is
/// what keeps the fallback a fallback. A simplified/traditional pair is *not*
/// one of those — no character table here — which is why the exact lookup above
/// follows redirects instead (解释 → 解釋).
pub fn title_matches_term(title: &str, term: &str) -> bool {
    let normalise = |s: &str| -> String {
        s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
    };
    let title = normalise(title);
    let term = normalise(term);
    if title.is_empty() || term.is_empty() {
        return false;
    }
    if title == term {
        return true;
    }
    let (short, long) = if title.len() < term.len() { (&title, &term) } else { (&term, &title) };
    short.chars().count() >= 2 && long.contains(short)
}

/// Fetches `/page/summary/{key}`; `Ok(None)` means "no such page here", so the
/// caller moves on to the search fallback or the next edition. Any other
/// failure is a hard error.
async fn fetch_summary(
    client: &reqwest::Client,
    key: &str,
    lang: &str,
) -> AppResult<Option<WikiSummary>> {
    // No trailing slash on the base: `path_segments_mut().push` appends after
    // the path's last segment, and a base ending in "/" makes that segment
    // empty — the request goes out as `summary//哲学`, which is a 404. That
    // double slash is why 维基百科 never answered: every summary fetch 404'd,
    // exact title and search fallback alike.
    let mut url =
        reqwest::Url::parse(&format!("https://{lang}.wikipedia.org/api/rest_v1/page/summary"))
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
async fn search_matching_key(
    client: &reqwest::Client,
    term: &str,
    lang: &str,
) -> AppResult<Option<String>> {
    let response = client
        .get(format!("https://{lang}.wikipedia.org/w/rest.php/v1/search/page"))
        // Five, not one: the index ranks by characters, so the wanted entry is
        // often not the first hit and the first hit is often not about the term
        // at all. `title_matches_term` then picks the one that is.
        .query(&[("q", term), ("limit", "5")])
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
    Ok(parsed
        .pages
        .into_iter()
        .find(|page| title_matches_term(&page.key, term))
        .map(|page| page.key))
}

/// One sense block from a web dictionary (维基词典, Urban Dictionary): a part
/// of speech and its plain-text meanings, ready for the lookup popup. Both
/// sources ship markup in their definitions; it is stripped here so the
/// popup's plain-text container never sees a tag.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDefinition {
    pub part_of_speech: String,
    pub meanings: Vec<String>,
    pub source_url: String,
}

/// Strips the light markup dictionary APIs sprinkle into definitions: tags
/// (only when the `<` really opens one — `a < b` survives), Urban
/// Dictionary's `[linked word]` brackets, and the handful of entities that
/// survive real definitions.
pub fn strip_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<'
            && bytes.get(i + 1).is_some_and(|b| b.is_ascii_alphabetic() || *b == b'/')
            && let Some(end) = text[i..].find('>')
        {
            i += end + 1;
            continue;
        }
        // Urban Dictionary links other slang terms as [word]; the link is
        // noise in a plain-text popup, the word is the point. Brackets that
        // span a line break are not links — the scan stops at one.
        if bytes[i] == b'['
            && let Some(end) = text[i + 1..].find([']', '\n'])
            && text.as_bytes()[i + 1 + end] == b']'
        {
            out.push_str(&text[i + 1..i + 1 + end]);
            i += end + 2;
            continue;
        }
        out.push(text[i..].chars().next().unwrap_or_default());
        i += text[i..].chars().next().unwrap_or_default().len_utf8();
    }
    // Entities last, the same order the StarDict renderer uses: decoding
    // `&amp;` before the others would fuse `&amp;lt;` into `<`.
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The Wiktionary language blocks worth showing, in order: the reader's
/// language first, English as the fallback — the same rule as
/// [`wiki_langs`].
pub fn wiktionary_langs(text: &str) -> &'static [&'static str] {
    if text.chars().any(|c| matches!(c, '\u{4E00}'..='\u{9FFF}')) { &["zh", "en"] } else { &["en"] }
}

#[derive(Debug, Deserialize)]
struct WiktionarySense {
    part_of_speech: String,
    #[serde(default)]
    definitions: Vec<WiktionaryGloss>,
}

#[derive(Debug, Deserialize)]
struct WiktionaryGloss {
    #[serde(default)]
    definition: String,
}

/// 维基词典 (English edition, which carries entries for words of every
/// language): sense blocks for the reader's language, then English. A term
/// the wiki does not know is a `NotFound`, which the popup treats as
/// "this source has nothing" — the other sources still answer.
pub async fn wiktionary_definitions(
    client: &reqwest::Client,
    term: &str,
) -> AppResult<Vec<WebDefinition>> {
    let term = term.trim();
    if term.is_empty() {
        return Err(AppError::InvalidArgument("没有要查询的词条".into()));
    }
    let key: String = term.chars().take(WIKI_TERM_CAP).collect();

    // No trailing slash — see `fetch_summary`: a base ending in "/" makes
    // `path_segments_mut().push` produce `definition//术语`, a 404.
    let mut url = reqwest::Url::parse("https://en.wiktionary.org/api/rest_v1/page/definition")
        .map_err(|err| AppError::Message(format!("URL 解析失败：{err}")))?;
    url.path_segments_mut().map_err(|_| AppError::Message("URL 解析失败".into()))?.push(&key);

    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, WIKI_USER_AGENT)
        .send()
        .await
        .map_err(|err| AppError::Message(format!("维基词典连接失败：{err}")))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::NotFound("维基词典没有收录这个词条".into()));
    }
    if !response.status().is_success() {
        return Err(AppError::Message(format!("维基词典请求失败（{}）", response.status())));
    }
    let entries: std::collections::HashMap<String, Vec<WiktionarySense>> = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("维基词典返回了无法解析的内容：{err}")))?;

    let source_url = format!("https://en.wiktionary.org/wiki/{}", key);
    let mut blocks = Vec::new();
    for lang in wiktionary_langs(&key) {
        for sense in entries.get(*lang).into_iter().flatten().take(2) {
            let meanings: Vec<String> = sense
                .definitions
                .iter()
                .map(|g| strip_markup(&g.definition))
                .filter(|m| !m.trim().is_empty())
                .take(6)
                .collect();
            if !meanings.is_empty() {
                blocks.push(WebDefinition {
                    part_of_speech: sense.part_of_speech.clone(),
                    meanings,
                    source_url: source_url.clone(),
                });
            }
        }
    }
    if blocks.is_empty() {
        return Err(AppError::NotFound("维基词典没有收录这个词条".into()));
    }
    Ok(blocks)
}

#[derive(Debug, Deserialize)]
struct UrbanResponse {
    #[serde(default)]
    list: Vec<UrbanEntry>,
}

#[derive(Debug, Deserialize)]
struct UrbanEntry {
    #[serde(default)]
    definition: String,
    #[serde(default)]
    example: String,
}

/// Urban Dictionary: the top definitions for a slang term. No key, no auth —
/// the whole API is public. The bracket links `[word]` become plain words.
pub async fn urban_definitions(
    client: &reqwest::Client,
    term: &str,
) -> AppResult<Vec<WebDefinition>> {
    let term = term.trim();
    if term.is_empty() {
        return Err(AppError::InvalidArgument("没有要查询的词条".into()));
    }
    let key: String = term.chars().take(WIKI_TERM_CAP).collect();

    let response = client
        .get("https://api.urbandictionary.com/v0/define")
        .query(&[("term", key.as_str())])
        .send()
        .await
        .map_err(|err| AppError::Message(format!("Urban Dictionary 连接失败：{err}")))?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "Urban Dictionary 请求失败（{}）",
            response.status()
        )));
    }
    let parsed: UrbanResponse = response.json().await.map_err(|err| {
        AppError::Message(format!("Urban Dictionary 返回了无法解析的内容：{err}"))
    })?;

    let blocks = to_urban_blocks(&parsed.list);
    if blocks.is_empty() {
        return Err(AppError::NotFound("Urban Dictionary 没有收录这个词条".into()));
    }
    let source_url = format!("https://www.urbandictionary.com/define.php?term={}", key);
    Ok(blocks
        .into_iter()
        .map(|mut block| {
            block.source_url = source_url.clone();
            block
        })
        .collect())
}

/// The top entries become one sense block; empty definitions drop out, and a
/// term with none of them is the caller's "nothing here".
fn to_urban_blocks(list: &[UrbanEntry]) -> Vec<WebDefinition> {
    let meanings: Vec<String> = list
        .iter()
        .take(3)
        .filter_map(|entry| {
            let definition = strip_markup(&entry.definition).trim().to_string();
            if definition.is_empty() {
                return None;
            }
            let example = strip_markup(&entry.example).trim().to_string();
            // The example is half of what an Urban entry is for; the popup
            // renders it as a second paragraph inside the same meaning.
            Some(if example.is_empty() {
                definition
            } else {
                format!("{definition}\n例：{example}")
            })
        })
        .collect();
    if meanings.is_empty() {
        return Vec::new();
    }
    vec![WebDefinition { part_of_speech: "slang".into(), meanings, source_url: String::new() }]
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
    fn a_search_hit_is_only_taken_when_it_is_the_term() {
        // The term itself, with the punctuation a title carries.
        assert!(title_matches_term("Rust (programming language)", "Rust"));
        assert!(title_matches_term("Machine learning", "learning"));
        // What the search index actually returns for a word with no article:
        // entries that merely share one rare glyph. None of these is 阐释.
        assert!(!title_matches_term("範鑄法", "阐释"));
        assert!(!title_matches_term("曾侯乙墓", "阐释"));
        assert!(!title_matches_term("耶稣", "阐释"));
        // One shared character is not a match either.
        assert!(!title_matches_term("解釋", "阐释"));
        // A whole sentence has no article, and must not borrow one.
        assert!(!title_matches_term("Jesus Christ", "耶稣是基督教的核心人物之一"));
        // Normalisation is on: case, spaces and punctuation.
        assert!(title_matches_term("Artificial intelligence", "artificial-intelligence"));
        // Nothing empty, nothing single-character borrowed.
        assert!(!title_matches_term("", "阐释"));
        assert!(!title_matches_term("A", "A theory of everything"));
    }

    #[test]
    fn the_wiki_edition_follows_the_script() {
        assert_eq!(wiki_langs("柏拉图"), &["zh", "en"]);
        assert_eq!(wiki_langs("ChatGPT"), &["en"]);
    }

    #[test]
    fn the_wiktionary_blocks_follow_the_script_too() {
        assert_eq!(wiktionary_langs("你好"), &["zh", "en"]);
        assert_eq!(wiktionary_langs("ubiquitous"), &["en"]);
    }

    #[test]
    fn markup_is_stripped_without_eating_prose() {
        assert_eq!(strip_markup("<b>bold</b> word"), "bold word");
        assert_eq!(strip_markup("a &amp; b"), "a & b");
        assert_eq!(strip_markup("&amp;lt; stays literal"), "&lt; stays literal");
        // A comparison survives: `<` not followed by a letter is prose.
        assert_eq!(strip_markup("3 < 5"), "3 < 5");
        // Urban Dictionary bracket links lose the brackets, keep the word.
        assert_eq!(strip_markup("[wicked] cool"), "wicked cool");
    }

    #[test]
    fn urban_definitions_use_bracket_free_text() {
        let parsed = UrbanResponse {
            list: vec![UrbanEntry {
                definition: "A [wicked] awesome thing.".into(),
                example: "That is wicked awesome.".into(),
            }],
        };
        let blocks = to_urban_blocks(&parsed.list);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].meanings[0], "A wicked awesome thing.\n例：That is wicked awesome.");
    }
}
