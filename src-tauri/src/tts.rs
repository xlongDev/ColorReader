//! Edge TTS: Microsoft's read-aloud service, the engine behind the voices no
//! platform ships locally.
//!
//! The reader's default voice is Yunjian, and Yunjian does not exist in
//! `AVSpeechSynthesisVoice` or any other OS list — it is a service voice
//! (`zh-CN-YunjianNeural`). Supporting "read in Yunjian" therefore means
//! speaking to that service, which is why this module exists at all.
//!
//! It runs on the Rust side deliberately. The webview cannot make this call
//! itself: the handshake needs a `Cookie` and an `Origin` the browser refuses
//! to let script set, and the `Sec-MS-GEC` token is a hash of the raw clock,
//! not of anything the renderer is trusted with. readest reached the same
//! conclusion and routes its own Edge client through Tauri IPC.
//!
//! Protocol notes that cost real debugging time, all verified against the live
//! service before this file was written:
//!
//! * `Sec-MS-GEC` is `SHA256(<Windows file-time ticks, rounded down to five
//!   minutes><trusted client token>)` in uppercase hex. The ticks value is
//!   ~1.3e17, so it is computed in integers here — a double cannot hold it.
//! * `Sec-MS-GEC-Version` must track a current Edge build. A stale version is
//!   answered with a bare `403` on the handshake and nothing else.
//! * A `Cookie: muid=<32 random hex>;` is required. Without it the handshake
//!   is also refused with `403`.
//! * Text frames and binary frames share one envelope: header lines, a blank
//!   line, then the body. The body of `audio.metadata` is the only place the
//!   per-word timings appear.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, Response};

use crate::error::{AppError, AppResult};

/// The public token every Edge client sends. It is not a secret — it ships in
/// the browser extension this endpoint belongs to — and the service takes it as
/// identification, not authentication.
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/// The Edge build whose signature the service currently accepts. Bumping this
/// is the fix when every handshake starts coming back `403`.
const CHROMIUM_VERSION: &str = "143.0.3650.75";

const VOICES_URL: &str =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const WSS_URL: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

/// Header block the handshake needs, as `(name, value)` so it can be built
/// without a macro or a builder type.
const HANDSHAKE_HEADERS: [(&str, &str); 6] = [
    ("pragma", "no-cache"),
    ("cache-control", "no-cache"),
    ("origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"),
    ("accept-encoding", "gzip, deflate, br, zstd"),
    ("accept-language", "en-US,en;q=0.9"),
    ("user-agent", USER_AGENT),
];

/// Audio constraints. 24 kHz mono MP3 at 48 kbps is what the service's own
/// client asks for and what `decodeAudioData` handles everywhere.
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";

/// Metadata offsets are in 100-nanosecond ticks.
const TICKS_PER_SECOND: f64 = 10_000_000.0;

/// One utterance per request. The cap is not the service's limit: it is the
/// reader's own guarantee that a request is a sentence and not a chapter, which
/// keeps a stalled request cheap to abandon and the audio small enough to hold
/// a couple of clips ahead of the voice.
const MAX_TEXT_CHARS: usize = 1_000;

/// How long one utterance may take. A socket that never answers has to surface
/// as a message the reader can act on, not as a player that never starts.
const SPEAK_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// Seconds to add to the local clock.
///
/// The signature is validated against the *service's* clock, so a machine whose
/// time has drifted is refused on every handshake and cannot recover on its
/// own. A refusal carries the server's own `Date`, which is enough to learn the
/// offset; `edge-tts` carries the same correction for the same reason.
static CLOCK_SKEW: AtomicI64 = AtomicI64::new(0);

fn local_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn now_seconds() -> i64 {
    local_seconds() + CLOCK_SKEW.load(Ordering::Relaxed)
}

/// The `Sec-MS-GEC` token: Windows file-time ticks rounded down to the nearest
/// five minutes, hashed with the client token.
///
/// Rounded so that a request and its immediate retry sign identically, and
/// integral because the value exceeds what a double represents exactly.
pub fn sec_ms_gec(unix_seconds: i64) -> String {
    const WIN_EPOCH: i64 = 11_644_473_600;
    let ticks = (unix_seconds + WIN_EPOCH) / 300 * 300 * 10_000_000;
    let mut hasher = Sha256::new();
    hasher.update(format!("{ticks}{TRUSTED_CLIENT_TOKEN}").as_bytes());
    hasher.finalize().iter().map(|byte| format!("{byte:02X}")).collect()
}

/// A random `muid`, the cookie value the handshake requires. Reusing the UUID
/// crate keeps this from needing a random-number dependency of its own.
fn muid() -> String {
    uuid::Uuid::new_v4().simple().to_string().to_uppercase()
}

/// The `X-Timestamp` both requests carry. Not a standard HTTP date, and not
/// worth normalising: the service parses its own format.
fn timestamp() -> String {
    chrono::Utc::now()
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string()
}

/// One word the service reports, `at` seconds from the start of the clip.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EdgeWord {
    pub at: f64,
    pub text: String,
}

/// One utterance: its audio, and where each word sits inside it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeClip {
    /// 24 kHz mono MP3, base64.
    ///
    /// Base64 inside the same payload as the timings rather than a raw IPC body
    /// on a second call: the two are useless apart, and one round trip per
    /// sentence is what keeps the prefetch simple.
    pub audio: String,
    pub words: Vec<EdgeWord>,
}

/// A voice the service offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoice {
    /// The service's id, e.g. `zh-CN-YunjianNeural`. This is what crosses the
    /// wire on every request, and what the reader's pick is stored as.
    pub short_name: String,
    /// Display name, without the locale prefix and the `Neural` suffix.
    pub name: String,
    pub locale: String,
    /// What the voice is styled for ("Novel", "News", "Dialect"). Yunjian,
    /// Yunxi, Yunxia and Yunyang are all male Mandarin voices that differ only
    /// by this, so it is the one label worth showing.
    pub categories: String,
}

/// Why one attempt did not produce a clip.
enum Attempt {
    /// Retrying cannot help.
    Failed(AppError),
    /// The handshake was rejected and the response carried the server's clock.
    Clock(i64),
}

impl From<AppError> for Attempt {
    fn from(err: AppError) -> Self {
        Attempt::Failed(err)
    }
}

fn http() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(LIST_TIMEOUT)
        .build()
        .map_err(|err| AppError::Message(format!("无法创建 HTTP 客户端：{err}")))
}

/// Network failures are reported in the reader's own words: a raw `reqwest`
/// string names the URL and tells someone listening to a book nothing.
fn offline(what: &str, err: reqwest::Error) -> AppError {
    if err.is_timeout() || err.is_connect() {
        AppError::Message(format!("{what}失败：无法连接 Edge 语音服务，请检查网络"))
    } else {
        AppError::Message(format!("{what}失败：{err}"))
    }
}

/// Every voice the service offers, in the reader's own sort order: locale, then
/// name, with plain byte comparison so the list never reshuffles between runs.
pub async fn voices() -> AppResult<Vec<EdgeVoice>> {
    let url = format!("{VOICES_URL}?trustedclienttoken={TRUSTED_CLIENT_TOKEN}");
    let response =
        http()?.get(&url).send().await.map_err(|err| offline("获取 Edge 语音列表", err))?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!("Edge 语音列表返回 {}", response.status().as_u16())));
    }
    let raw: Vec<RawVoice> = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("Edge 语音列表无法解析：{err}")))?;

    let mut voices: Vec<EdgeVoice> = raw
        .into_iter()
        .map(|voice| EdgeVoice {
            name: display_name(&voice.short_name, &voice.locale),
            short_name: voice.short_name,
            locale: voice.locale,
            categories: voice.tag.categories.join(" / "),
        })
        .collect();
    voices.sort_by(|a, b| {
        (a.locale.as_str(), a.name.as_str()).cmp(&(b.locale.as_str(), b.name.as_str()))
    });
    Ok(voices)
}

/// `zh-CN-YunjianNeural` in `zh-CN` comes back as `Yunjian` — the service never
/// localises names, so the id is the only place the bare name exists.
fn display_name(short_name: &str, locale: &str) -> String {
    let tail = short_name
        .strip_prefix(locale)
        .and_then(|rest| rest.strip_prefix('-'))
        .unwrap_or(short_name);
    tail.strip_suffix("Neural").unwrap_or(tail).to_string()
}

/// Reads one utterance.
pub async fn speak(text: &str, voice: &str, rate: f64) -> AppResult<EdgeClip> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::InvalidArgument("没有可朗读的文本".into()));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::InvalidArgument(format!(
            "单次朗读最长 {MAX_TEXT_CHARS} 字，请分段朗读"
        )));
    }
    check_voice(voice)?;
    let rate = rate.clamp(0.5, 2.0);

    let run = tokio::time::timeout(SPEAK_TIMEOUT, attempt(text, voice, rate));
    match run.await {
        Ok(Ok(clip)) => Ok(clip),
        // One correction, then give up: a second rejection is not a clock.
        Ok(Err(Attempt::Clock(server))) => {
            CLOCK_SKEW.store(server - local_seconds(), Ordering::Relaxed);
            tracing::info!(skew = server - local_seconds(), "corrected clock for Edge TTS");
            match tokio::time::timeout(SPEAK_TIMEOUT, attempt(text, voice, rate)).await {
                Ok(result) => result.map_err(|failure| match failure {
                    Attempt::Failed(err) => err,
                    Attempt::Clock(_) => refused_error(),
                }),
                Err(_) => Err(timeout_error()),
            }
        }
        Ok(Err(Attempt::Failed(err))) => Err(err),
        Err(_) => Err(timeout_error()),
    }
}

fn timeout_error() -> AppError {
    AppError::Message("Edge 语音请求超时，请检查网络后重试".into())
}

fn refused_error() -> AppError {
    AppError::Message("Edge 语音服务拒绝了握手，请稍后重试或切换到系统语音".into())
}

/// The voice id is interpolated into an SSML attribute, so it is validated
/// rather than escaped: a quote in here would inject markup, and no real id
/// contains anything but ASCII letters, digits and hyphens.
fn check_voice(voice: &str) -> AppResult<()> {
    let valid = !voice.is_empty()
        && voice.len() <= 64
        && voice.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        return Ok(());
    }
    Err(AppError::InvalidArgument(format!("无效的语音标识：{voice}")))
}

/// XML-escapes the three characters that could end an element early. The text
/// is book content, so `&` and `<` are routine rather than theoretical.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The service escapes the words it reports back; `&amp;` here is a real `&`.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The UI's multiplier as the `rate` attribute. The reader's range (0.5–2×)
/// maps exactly onto ±100%, and the service does the time-stretching itself, so
/// the audio is never pitch-shifted the way `playbackRate` would shift it.
pub fn prosody_rate(rate: f64) -> String {
    let percent = ((rate.clamp(0.5, 2.0) - 1.0) * 100.0).round() as i32;
    format!("{percent:+}%")
}

/// The SSML for one utterance, with the reader's own locale on the `voice`.
fn ssml(text: &str, voice: &str, rate: f64) -> String {
    let locale = voice.split('-').take(2).collect::<Vec<_>>().join("-");
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{locale}'>\
         <voice name='{voice}'><prosody pitch='+0Hz' rate='{}' volume='+0%'>{}</prosody></voice>\
         </speak>",
        prosody_rate(rate),
        escape(text)
    )
}

/// The `speech.config` frame. Word boundaries only: sentence boundaries would
/// arrive as a second, redundant cue list for a queue that is already
/// sentence-shaped.
fn speech_config() -> String {
    let config = serde_json::json!({
        "context": {
            "synthesis": {
                "audio": {
                    "metadataoptions": {
                        "sentenceBoundaryEnabled": "false",
                        "wordBoundaryEnabled": "true",
                    },
                    "outputFormat": OUTPUT_FORMAT,
                }
            }
        }
    });
    format!(
        "X-Timestamp:{}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{config}",
        timestamp()
    )
}

/// The `ssml` frame. The trailing `Z` on `X-Timestamp` is on this request only;
/// it is not a typo here, it is what the service's own client sends.
fn ssml_frame(text: &str, voice: &str, rate: f64) -> String {
    format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}Z\r\nPath:ssml\r\n\r\n{}",
        uuid::Uuid::new_v4().simple(),
        timestamp(),
        ssml(text, voice, rate)
    )
}

/// One `key:value` line out of a frame header block.
fn header_value<'a>(head: &'a str, key: &str) -> Option<&'a str> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.trim())
}

/// Splits a frame into its header block and its body. Both frame kinds share
/// this envelope, so one splitter covers text and binary alike.
fn split_frame(raw: &[u8]) -> (&str, &[u8]) {
    let boundary = raw.windows(4).position(|window| window == b"\r\n\r\n").map(|at| at + 4);
    match boundary {
        Some(at) => {
            (std::str::from_utf8(&raw[..at]).unwrap_or(""), raw.get(at..).unwrap_or_default())
        }
        None => (std::str::from_utf8(raw).unwrap_or(""), &[]),
    }
}

/// A binary frame is `[u16 header length][header][audio]`; the length is
/// declared, so the split does not have to search for it.
fn split_binary(raw: &[u8]) -> Option<(&str, &[u8])> {
    let first = *raw.first()?;
    let second = *raw.get(1)?;
    let length = u16::from_be_bytes([first, second]) as usize;
    let head = std::str::from_utf8(raw.get(2..2 + length)?).ok()?;
    Some((head, raw.get(2 + length..)?))
}

/// The word timings out of one `audio.metadata` body.
fn parse_words(body: &[u8]) -> AppResult<Vec<EdgeWord>> {
    let envelope: MetadataEnvelope = serde_json::from_slice(body)?;
    Ok(envelope
        .metadata
        .into_iter()
        .filter(|item| item.kind == "WordBoundary")
        // `Data` is absent on the service's own bookkeeping frames
        // (`SessionEnd`), which are announced through the same channel.
        .filter_map(|item| item.data)
        .map(|data| EdgeWord {
            at: data.offset as f64 / TICKS_PER_SECOND,
            // Offsets are honest inside a single turn: the drift the service's
            // own client compensates for only accumulates across turns, and one
            // sentence is one turn here.
            text: unescape(&data.text.text),
        })
        .collect())
}

#[derive(Deserialize)]
struct MetadataEnvelope {
    #[serde(rename = "Metadata", default)]
    metadata: Vec<MetadataItem>,
}

#[derive(Deserialize)]
struct MetadataItem {
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "Data", default)]
    data: Option<MetadataData>,
}

#[derive(Deserialize, Default)]
struct MetadataData {
    #[serde(rename = "Offset", default)]
    offset: u64,
    #[serde(rename = "text", default)]
    text: MetadataWord,
}

#[derive(Deserialize, Default)]
struct MetadataWord {
    #[serde(rename = "Text", default)]
    text: String,
}

#[derive(Deserialize)]
struct RawVoice {
    #[serde(rename = "ShortName")]
    short_name: String,
    #[serde(rename = "Locale")]
    locale: String,
    #[serde(rename = "VoiceTag", default)]
    tag: RawTag,
}

#[derive(Deserialize, Default)]
struct RawTag {
    #[serde(rename = "ContentCategories", default)]
    categories: Vec<String>,
}

/// One handshake, one request, one clip.
async fn attempt(text: &str, voice: &str, rate: f64) -> Result<EdgeClip, Attempt> {
    let url = format!(
        "{WSS_URL}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-{CHROMIUM_VERSION}&ConnectionId={}",
        sec_ms_gec(now_seconds()),
        uuid::Uuid::new_v4().simple()
    );
    let mut request = url
        .into_client_request()
        .map_err(|err| Attempt::Failed(AppError::Message(format!("Edge 语音地址无效：{err}"))))?;
    {
        let headers = request.headers_mut();
        for (name, value) in HANDSHAKE_HEADERS {
            headers.insert(HeaderName::from_static(name), HeaderValue::from_static(value));
        }
        // The service refuses the handshake outright without this cookie, and
        // the value is only ever echoed back, so a fresh random one per request
        // is both sufficient and the least identifying thing to send.
        let cookie = HeaderValue::from_str(&format!("muid={};", muid())).map_err(|err| {
            Attempt::Failed(AppError::Message(format!("无法生成握手凭据：{err}")))
        })?;
        headers.insert(HeaderName::from_static("cookie"), cookie);
    }

    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.map_err(classify)?;

    socket
        .send(Message::text(speech_config()))
        .await
        .map_err(|err| Attempt::Failed(socket_error(err)))?;
    socket
        .send(Message::text(ssml_frame(text, voice, rate)))
        .await
        .map_err(|err| Attempt::Failed(socket_error(err)))?;

    let mut audio: Vec<u8> = Vec::new();
    let mut words: Vec<EdgeWord> = Vec::new();
    while let Some(message) = socket.next().await {
        match message.map_err(|err| Attempt::Failed(socket_error(err)))? {
            Message::Text(raw) => {
                let (head, body) = split_frame(raw.as_bytes());
                match header_value(head, "Path") {
                    Some("audio.metadata") => words.extend(parse_words(body)?),
                    Some("turn.end") => break,
                    _ => {}
                }
            }
            Message::Binary(raw) => {
                let Some((head, payload)) = split_binary(&raw) else { continue };
                if header_value(head, "Path") == Some("audio") {
                    audio.extend_from_slice(payload);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if audio.is_empty() {
        return Err(Attempt::Failed(AppError::Message(
            "Edge 语音没有返回音频，请重试或切换语音".into(),
        )));
    }
    Ok(EdgeClip { audio: STANDARD.encode(&audio), words })
}

/// A rejected handshake says which of the two failures this is: a version or
/// signature the service refuses, or a clock that has drifted. The response's
/// own `Date` is what tells them apart.
fn classify(err: WsError) -> Attempt {
    let WsError::Http(response) = &err else {
        return Attempt::Failed(socket_error(err));
    };
    match server_seconds(response) {
        Some(server) => Attempt::Clock(server),
        None => Attempt::Failed(refused_error()),
    }
}

/// The server's clock, out of the `Date` a refusal carries.
fn server_seconds(response: &Response<Option<Vec<u8>>>) -> Option<i64> {
    let raw = response.headers().get("date")?.to_str().ok()?;
    chrono::DateTime::parse_from_rfc2822(raw).ok().map(|at| at.timestamp())
}

fn socket_error(err: WsError) -> AppError {
    match err {
        WsError::Http(ref response) => {
            let status = response.status().as_u16();
            tracing::warn!(status, "Edge TTS handshake refused");
            AppError::Message(format!("Edge 语音握手被拒绝（HTTP {status}）"))
        }
        other => AppError::Message(format!("Edge 语音连接中断：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vectors generated from the reference implementation, so a change to the
    /// rounding or the hashing shows up here rather than as a live `403`.
    #[test]
    fn the_signature_matches_the_reference_implementation() {
        assert_eq!(
            sec_ms_gec(1_757_567_220),
            "05F5ADA786BE35CE66D0F65305E53A03B00CEC2726CF586DF32D62853D01BEF7"
        );
        assert_eq!(
            sec_ms_gec(1_757_567_400),
            "AF6A6255468F0BB81E458EE56B4D211669667B4E2075BE754D87DDF742891A6A"
        );
        assert_eq!(
            sec_ms_gec(0),
            "7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C"
        );
    }

    #[test]
    fn the_signature_only_changes_every_five_minutes() {
        assert_eq!(sec_ms_gec(1_757_567_220), sec_ms_gec(1_757_567_399));
        assert_ne!(sec_ms_gec(1_757_567_399), sec_ms_gec(1_757_567_400));
    }

    #[test]
    fn the_clock_correction_is_read_from_a_real_rejection_header() {
        // Captured verbatim from a live refusal.
        let raw = "Fri, 11 Sep 2026 04:56:00 GMT";
        let parsed = chrono::DateTime::parse_from_rfc2822(raw).expect("RFC 2822 with GMT");
        assert_eq!(parsed.timestamp(), 1_789_102_560);
    }

    #[test]
    fn the_rate_attribute_spans_the_readers_whole_range() {
        assert_eq!(prosody_rate(0.5), "-50%");
        assert_eq!(prosody_rate(1.0), "+0%");
        assert_eq!(prosody_rate(1.5), "+50%");
        assert_eq!(prosody_rate(2.0), "+100%");
        // Out of range clamps rather than sending something the service rejects.
        assert_eq!(prosody_rate(9.0), "+100%");
        assert_eq!(prosody_rate(0.1), "-50%");
    }

    #[test]
    fn book_text_cannot_break_out_of_the_ssml() {
        let markup = ssml("Tom & <Jerry>", "zh-CN-YunjianNeural", 1.0);
        assert!(markup.contains("Tom &amp; &lt;Jerry&gt;"), "{markup}");
        assert_eq!(markup.matches("<voice").count(), 1);
        assert!(markup.starts_with("<speak version='1.0'"));
    }

    #[test]
    fn a_voice_id_is_checked_before_it_reaches_the_markup() {
        assert!(check_voice("zh-CN-YunjianNeural").is_ok());
        assert!(check_voice("en-US-EmmaMultilingualNeural").is_ok());
        assert!(check_voice("zh-CN-x'><script>").is_err(), "引号必须被拒绝");
        assert!(check_voice("").is_err());
        assert!(check_voice(&"a".repeat(65)).is_err());
    }

    #[test]
    fn frame_headers_are_read_without_the_body_confusing_them() {
        let (head, body) = split_frame(b"Path:audio.metadata\r\nX-Foo:1\r\n\r\n{\"Metadata\":[]}");
        assert_eq!(header_value(head, "Path"), Some("audio.metadata"));
        assert_eq!(header_value(head, "path"), Some("audio.metadata"), "大小写不敏感");
        assert_eq!(body, b"{\"Metadata\":[]}");
    }

    #[test]
    fn a_binary_frame_is_split_at_its_declared_length() {
        let head = b"Path:audio\r\nContent-Type:audio/mpeg";
        let mut raw = (head.len() as u16).to_be_bytes().to_vec();
        raw.extend_from_slice(head);
        raw.extend_from_slice(b"\xff\xfb\x90\x00");
        let (head, payload) = split_binary(&raw).expect("frame");
        assert_eq!(header_value(head, "Path"), Some("audio"));
        assert_eq!(payload, b"\xff\xfb\x90\x00");
    }

    #[test]
    fn word_boundaries_become_seconds() {
        let body = r#"{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":0,"Duration":3000000,"text":{"Text":"你好","Length":2}}},{"Type":"WordBoundary","Data":{"Offset":21375000,"Duration":4000000,"text":{"Text":"一次","Length":2}}},{"Type":"SessionEnd","Data":{}}]}"#;
        let words = parse_words(body.as_bytes()).expect("parse");
        assert_eq!(words.len(), 2, "SessionEnd 不是词");
        assert_eq!(words[0].at, 0.0);
        assert_eq!(words[1].text, "一次");
        assert!((words[1].at - 2.1375).abs() < 1e-9, "100ns 刻度换算成秒");
    }

    #[test]
    fn escaped_words_come_back_as_written() {
        let body = r#"{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":0,"Duration":1,"text":{"Text":"a &amp; b &lt;c&gt;"}}}]}"#;
        assert_eq!(parse_words(body.as_bytes()).expect("parse")[0].text, "a & b <c>");
    }

    #[test]
    fn display_names_drop_the_locale_and_the_engine_suffix() {
        assert_eq!(display_name("zh-CN-YunjianNeural", "zh-CN"), "Yunjian");
        assert_eq!(display_name("zh-CN-liaoning-XiaobeiNeural", "zh-CN-liaoning"), "Xiaobei");
        assert_eq!(display_name("zh-TW-YunJheNeural", "zh-TW"), "YunJhe");
        assert_eq!(display_name("oddity", "zh-CN"), "oddity");
    }

    /// The two live checks. Everything above tests this file's own arithmetic;
    /// these test that the arithmetic is still the service's arithmetic, which
    /// no offline fixture can answer — Microsoft moves the version gate.
    ///
    /// `cargo test --release edge -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the live Edge service"]
    fn the_service_still_lists_yunjian() {
        let voices = tauri::async_runtime::block_on(voices()).expect("voice list");
        assert!(voices.len() > 100, "只有 {} 个语音", voices.len());
        let yunjian = voices
            .iter()
            .find(|voice| voice.short_name == "zh-CN-YunjianNeural")
            .expect("Yunjian 必须还在列表里");
        assert_eq!(yunjian.name, "Yunjian");
        assert_eq!(yunjian.locale, "zh-CN");
    }

    #[test]
    #[ignore = "hits the live Edge service"]
    fn the_service_still_returns_audio_and_word_timings() {
        let clip = tauri::async_runtime::block_on(speak(
            "你好，这是 ColorReader 的语音引擎测试。",
            "zh-CN-YunjianNeural",
            1.0,
        ))
        .expect("clip");
        assert!(clip.audio.len() > 1_000, "音频太短：{}", clip.audio.len());
        assert!(!clip.words.is_empty(), "没有词边界");
        assert!(
            clip.words.windows(2).all(|pair| pair[0].at <= pair[1].at),
            "词边界必须按时间递增：{:?}",
            clip.words
        );
        let first = &clip.words[0];
        assert!(first.at < 0.5, "第一个词不该在 {}s 之后", first.at);
    }

    #[test]
    #[ignore = "hits the live Edge service"]
    fn an_out_of_range_rate_is_still_accepted() {
        let fast = tauri::async_runtime::block_on(speak("测试。", "zh-CN-YunjianNeural", 2.0))
            .expect("2x clip");
        let slow = tauri::async_runtime::block_on(speak("测试。", "zh-CN-YunjianNeural", 0.5))
            .expect("0.5x clip");
        assert!(
            fast.audio.len() < slow.audio.len(),
            "2× 的音频必须比 0.5× 短：{} vs {}",
            fast.audio.len(),
            slow.audio.len()
        );
    }
}
