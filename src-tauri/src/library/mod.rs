//! The library domain: sorting rules, cover URLs and book removal.

pub mod annotations;
pub mod bookmarks;
pub mod chapters;
pub mod graph;
pub mod import;
pub mod pack;
pub mod rag;
pub mod repository;
pub mod search;
pub mod source;
pub mod sync;

#[cfg(test)]
mod bench;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::Library;
use crate::error::AppResult;

/// English articles ignored when building a sort key.
const LEADING_ARTICLES: [&str; 3] = ["the ", "a ", "an "];

/// Lower-cased, article-stripped key used for `ORDER BY` on titles.
pub fn sort_key(title: &str) -> String {
    let mut key = title.trim().to_lowercase();
    for article in LEADING_ARTICLES {
        if let Some(rest) = key.strip_prefix(article) {
            key = rest.trim_start().to_string();
            break;
        }
    }
    key
}

/// Wall clock as Unix seconds. Falls back to the epoch rather than panicking.
pub fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Origin that serves book resources to the webview.
///
/// Tauri registers custom protocols at `<scheme>://localhost` on macOS, iOS and
/// Linux, but at `http://<scheme>.localhost` on Windows and Android. The Rust
/// side knows the target at compile time, so the frontend never has to guess
/// from a user agent.
pub const fn resource_origin() -> &'static str {
    if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://colorreader.localhost"
    } else {
        "colorreader://localhost"
    }
}

/// Absolute URL for a book's cover, valid only when the book has one.
pub fn cover_url(book_id: &str) -> String {
    format!("{}/cover/{book_id}", resource_origin())
}

/// Deletes a book row and its files.
///
/// The row is authoritative: once it is gone the book is gone even if unlinking
/// a file fails, because leaving an orphan row would resurrect it on next boot.
pub fn delete_book(library: &Library, id: &str) -> AppResult<()> {
    let files = library.with(|conn| repository::delete(conn, id))?;
    for path in [files.book, files.cover].into_iter().flatten() {
        if let Err(err) = std::fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), error = %err, "删除书籍文件失败");
        }
    }
    Ok(())
}

/// Absolute cover path for `id`, used by the resource protocol.
pub fn cover_file(library: &Library, id: &str) -> AppResult<Option<PathBuf>> {
    library.with(|conn| repository::cover_path(conn, id))
}

/// Paths of the book and cover files for `id`, without deleting anything.
pub fn book_files(library: &Library, id: &str) -> AppResult<(Option<PathBuf>, Option<PathBuf>)> {
    library.with(|conn| {
        let (book, cover): (String, Option<String>) = conn.query_row(
            "SELECT file_path, cover_path FROM books WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((Some(PathBuf::from(book)), cover.map(PathBuf::from)))
    })
}

/// Lower-case hex. Written out because `digest`'s output array does not
/// implement `LowerHex`.
pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Inverse of [`to_hex`]; `None` for odd lengths or non-hex characters.
pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn articles_are_only_stripped_at_the_start() {
        assert_eq!(sort_key("The Rust Book"), "rust book");
        assert_eq!(sort_key("Anatomy of a Book"), "anatomy of a book");
    }

    #[test]
    fn sort_keys_are_trimmed_and_lowercased() {
        assert_eq!(sort_key("  Mixed CASE  "), "mixed case");
        assert_eq!(sort_key(""), "");
    }

    #[test]
    fn cover_urls_use_the_platform_origin() {
        let url = cover_url("abc");
        assert!(url.ends_with("/cover/abc"), "{url}");
        assert!(url.starts_with(resource_origin()), "{url}");
    }
}
