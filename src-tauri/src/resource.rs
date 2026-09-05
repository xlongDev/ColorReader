//! Custom protocol that serves book resources (covers) to the webview.
//!
//! Cover images live in the per-user data directory, outside the asset bundle,
//! so `<img src>` cannot point at them directly. A registered scheme keeps the
//! files private: nothing else on the machine can address them, and the
//! webview never learns a filesystem path.

use std::borrow::Cow;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::Builder;
use tauri::http::{HeaderValue, Request, Response, StatusCode, header::CONTENT_TYPE};

use crate::db::Library;
use crate::document::image_mime;
use crate::library::cover_file;

/// Scheme registered with Tauri. Also the host prefix on Windows and Android,
/// where custom protocols are served as `http://<scheme>.localhost`.
pub const SCHEME: &str = "colorreader";

/// Path prefix under which cover images are addressed.
const COVER_PREFIX: &str = "/cover/";

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
    match cover_id(request.uri().path()) {
        Some(id) => registry.cover(id, &uri),
        None => {
            tracing::warn!(uri = %uri, "资源协议收到无法识别的路径");
            empty(StatusCode::NOT_FOUND)
        }
    }
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
