//! Custom protocol that serves book resources (covers) to the webview.
//!
//! Cover images live in the per-user data directory, outside the asset bundle,
//! so `<img src>` cannot point at them directly. A registered scheme keeps the
//! files private: nothing else on the machine can address them, and the
//! webview never learns a filesystem path.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::Builder;
use tauri::http::{
    HeaderValue, Request, Response, StatusCode,
    header::{
        ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    },
};

use crate::db::Library;
use crate::document::{BookFormat, image_mime};
use crate::library::{cover_file, repository};

/// Scheme registered with Tauri. Also the host prefix on Windows and Android,
/// where custom protocols are served as `http://<scheme>.localhost`.
pub const SCHEME: &str = "colorreader";

/// Path prefix under which cover images are addressed.
const COVER_PREFIX: &str = "/cover/";

/// Path prefix under which source files are addressed. The webview streams
/// these with HTTP Range requests so opening a book no longer transfers the
/// whole file over IPC (see `Registry::book`).
const BOOK_PREFIX: &str = "/book/";

/// Slot the protocol handler reads from.
///
/// Tauri runs the setup hook on the event loop's `Ready` event, which is after
/// the webview has been created, so the browser can ask for a cover before the
/// database exists. Until setup publishes the library, requests answer 503 and
/// the browser retries on the next render.
#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<Option<Library>>>);

impl Registry {
    /// Publishes the opened library. Called once, from setup.
    pub fn set(&self, library: Library) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(library);
        }
    }

    fn library(&self) -> Option<Library> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

/// Attaches the scheme to the builder.
///
/// Tauri 2 only accepts protocol handlers while the app is being assembled, so
/// the handler is installed from the builder chain rather than from the setup
/// hook, where the database would already be available.
pub fn install(builder: Builder<tauri::Wry>, registry: Registry) -> Builder<tauri::Wry> {
    builder
        .register_uri_scheme_protocol(SCHEME, move |_context, request| serve(&registry, &request))
}

/// Answers one protocol request. Every failure maps to a status code; the
/// handler never propagates an error out of the webview runtime.
fn serve(registry: &Registry, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri().to_string();
    let path = request.uri().path();
    if let Some(id) = cover_id(path) {
        return registry.cover(id, &uri);
    }
    if let Some(id) = book_id(path) {
        return registry.book(id, request);
    }
    tracing::warn!(uri = %uri, "资源协议收到无法识别的路径");
    empty(StatusCode::NOT_FOUND)
}

impl Registry {
    fn cover(&self, id: &str, uri: &str) -> Response<Cow<'static, [u8]>> {
        let Some(library) = self.library() else {
            tracing::debug!(uri = %uri, "书库尚未就绪，拒绝资源请求");
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };

        let path = match cover_file(&library, id) {
            Ok(path) => path,
            Err(err) => {
                tracing::warn!(uri = %uri, error = %err, "查询封面失败");
                return empty(StatusCode::INTERNAL_SERVER_ERROR);
            }
        };
        let Some(path) = path else {
            return empty(StatusCode::NOT_FOUND);
        };

        match std::fs::read(&path) {
            Ok(bytes) => {
                let mut response = Response::new(Cow::Owned(bytes));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static(mime_of(&path)));
                response
            }
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "读取封面失败");
                empty(StatusCode::NOT_FOUND)
            }
        }
    }

    /// Streams a book's source file, honouring `Range` so the reader downloads
    /// only the bytes it needs (the OPF, a section, the central directory) and
    /// the open time stops scaling with the file size. A `fetch` from the
    /// webview is cross-origin, so `Access-Control-Allow-Origin` is set.
    fn book(&self, id: &str, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
        let Some(library) = self.library() else {
            tracing::debug!(id, "书库尚未就绪，拒绝资源请求");
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        let (file_path, format) = match library.with(|conn| repository::source(conn, id)) {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(id, error = %err, "查询书籍源文件失败");
                return empty(StatusCode::NOT_FOUND);
            }
        };
        let path = Path::new(&file_path);
        let Ok(total) = std::fs::metadata(path).map(|meta| meta.len()) else {
            return empty(StatusCode::NOT_FOUND);
        };

        let range =
            request.headers().get(tauri::http::header::RANGE).and_then(|value| value.to_str().ok());
        let (status, body, content_range, content_length) = match read_range(path, total, range) {
            Ok(result) => {
                let RangeResult { bytes, content_range } = result;
                let length = bytes.len();
                (StatusCode::PARTIAL_CONTENT, Cow::Owned(bytes), Some(content_range), length)
            }
            Err(_) => match std::fs::read(path) {
                Ok(bytes) => {
                    let length = bytes.len();
                    (StatusCode::OK, Cow::Owned(bytes), None, length)
                }
                Err(err) => {
                    tracing::warn!(path = %path.display(), error = %err, "读取源文件失败");
                    return empty(StatusCode::NOT_FOUND);
                }
            },
        };

        let mut response = Response::new(body);
        *response.status_mut() = status;
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(book_mime(format)));
        headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&content_length.to_string())
                .unwrap_or_else(|_| HeaderValue::from_static("0")),
        );
        if let Some(range_value) = content_range
            && let Ok(value) = HeaderValue::from_str(&range_value)
        {
            headers.insert(CONTENT_RANGE, value);
        }
        // The webview fetches the protocol from its own origin; allow it.
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        response
    }
}

/// Book id from a request path, or `None` when the path is not a cover we own.
///
/// Ids are v4 UUIDs, so anything outside hex and dashes is rejected outright:
/// the id is never used to build a path, but refusing early keeps a malformed
/// or hostile URL from reaching a query at all.
fn cover_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix(COVER_PREFIX)?;
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    valid.then_some(id)
}

/// Book id from a request path, or `None` when the path is not a source file
/// we own. Mirrors `cover_id`'s validation so a malformed or hostile URL never
/// reaches a query.
fn book_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix(BOOK_PREFIX)?;
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    valid.then_some(id)
}

/// Content type announced for a served source file.
fn book_mime(format: BookFormat) -> &'static str {
    match format {
        BookFormat::Epub => "application/epub+zip",
        BookFormat::Mobi => "application/x-mobipocket-ebook",
        BookFormat::Cbz => "application/vnd.comicbook+zip",
        BookFormat::Fb2 => "application/x-fictionbook+xml",
        _ => "application/octet-stream",
    }
}

/// A single satisfiable byte range and the `Content-Range` it implies.
struct RangeResult {
    bytes: Vec<u8>,
    content_range: String,
}

/// Reads one `Range` window from `path`. `None` (no header or unparseable)
/// means the caller should serve the whole file.
fn read_range(path: &Path, total: u64, range: Option<&str>) -> Result<RangeResult, std::io::Error> {
    let Some((start, end)) = parse_range(range, total) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsatisfiable range"));
    };
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let length = (end - start + 1) as usize;
    let mut buffer = vec![0u8; length];
    file.read_exact(&mut buffer)?;
    Ok(RangeResult { bytes: buffer, content_range: format!("bytes {start}-{end}/{total}") })
}

/// Parses an HTTP `Range` header into an inclusive `[start, end]` window that
/// sits inside `[0, total - 1]`. Supports `start-end`, `start-` and `-suffix`.
fn parse_range(header: Option<&str>, total: u64) -> Option<(u64, u64)> {
    let header = header?.trim();
    let ranges = header.strip_prefix("bytes=")?.trim();
    let segment = ranges.split(',').next()?.trim();
    let (start_text, end_text) = segment.split_once('-')?;
    let (start, end) = if end_text.is_empty() {
        let start = start_text.parse::<u64>().ok()?;
        (start, total.saturating_sub(1))
    } else if start_text.is_empty() {
        let suffix = end_text.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        (total.saturating_sub(suffix), total.saturating_sub(1))
    } else {
        (start_text.parse::<u64>().ok()?, end_text.parse::<u64>().ok()?)
    };
    let end = end.min(total.saturating_sub(1));
    if start > end {
        return None;
    }
    Some((start, end))
}

fn mime_of(path: &Path) -> &'static str {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(image_mime)
        .unwrap_or("application/octet-stream")
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    let mut response = Response::new(Cow::Borrowed(&[] as &[u8]));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_paths_accept_uuids() {
        assert_eq!(
            cover_id("/cover/6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"),
            Some("6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f")
        );
        assert_eq!(cover_id("/cover/abc"), Some("abc"));
    }

    #[test]
    fn anything_that_is_not_a_cover_is_rejected() {
        assert_eq!(cover_id("/book/abc"), None);
        assert_eq!(cover_id("/cover/"), None);
        assert_eq!(cover_id("/cover/../../etc/passwd"), None);
        assert_eq!(cover_id("/cover/with space"), None);
        assert_eq!(cover_id("/cover"), None);
        // Longer than any id we issue.
        assert_eq!(cover_id(&format!("/cover/{}", "a".repeat(65))), None);
    }

    #[test]
    fn book_paths_accept_uuids_and_reject_garbage() {
        assert_eq!(
            book_id("/book/6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"),
            Some("6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f")
        );
        assert_eq!(book_id("/book/"), None);
        assert_eq!(book_id("/book/with space"), None);
        assert_eq!(book_id("/book/../../etc/passwd"), None);
        assert_eq!(book_id("/cover/abc"), None);
    }

    #[test]
    fn range_parser_covers_the_common_forms() {
        // Closed window.
        assert_eq!(parse_range(Some("bytes=100-199"), 1000), Some((100, 199)));
        // Open-ended start: read to the end.
        assert_eq!(parse_range(Some("bytes=900-"), 1000), Some((900, 999)));
        // Suffix form.
        assert_eq!(parse_range(Some("bytes=-50"), 1000), Some((950, 999)));
        // End clamped to the file size.
        assert_eq!(parse_range(Some("bytes=900-5000"), 1000), Some((900, 999)));
        // No header, or malformed, or inverted window: nothing to satisfy.
        assert_eq!(parse_range(None, 1000), None);
        assert_eq!(parse_range(Some("items=0-10"), 1000), None);
        assert_eq!(parse_range(Some("bytes=200-100"), 1000), None);
        assert_eq!(parse_range(Some("bytes=-0"), 1000), None);
    }

    #[test]
    fn unregistered_requests_answer_service_unavailable() {
        let registry = Registry::default();
        let response = registry.cover("6f1d2c3e", "colorreader://localhost/cover/6f1d2c3e");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn mime_falls_back_to_octet_stream() {
        assert_eq!(mime_of(Path::new("a.png")), "image/png");
        assert_eq!(mime_of(Path::new("a")), "application/octet-stream");
    }
}
