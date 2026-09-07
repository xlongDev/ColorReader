//! Comic book archives: a ZIP of page images, one page per chapter.
//!
//! There is no prose to extract and no metadata container, so the whole format
//! rides on the machinery EPUB already uses: pages are recorded as image marker
//! paragraphs (see [`IMAGE_PARAGRAPH_PREFIX`]) and the reader fetches the bytes
//! lazily through the same `book.asset` command.

use std::io::Read;
use std::path::Path;

use zip::ZipArchive;

use super::{BookMetadata, CoverImage, IMAGE_PARAGRAPH_PREFIX, RawChapter};
use crate::error::{AppError, AppResult};

/// Refuse to buffer more than this for a cover page.
const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;

/// Reads the first page as the cover. A CBZ has no metadata block, so the title
/// falls back to the file name (applied by the caller).
pub fn read_metadata(path: &Path) -> AppResult<BookMetadata> {
    let pages = page_entries(path)?;
    let Some(first) = pages.first() else {
        return Err(AppError::Parse("CBZ 压缩包里没有图片页".into()));
    };

    let file = std::fs::File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|err| AppError::Parse(format!("无法打开 CBZ 容器：{err}")))?;
    let entry =
        archive.by_name(first).map_err(|_| AppError::Parse(format!("CBZ 缺少页面：{first}")))?;
    let mut bytes = Vec::new();
    entry.take(MAX_COVER_BYTES).read_to_end(&mut bytes)?;

    Ok(BookMetadata {
        cover: Some(CoverImage { extension: extension_of(first), bytes }),
        ..BookMetadata::default()
    })
}

/// One chapter per page, in natural page order.
///
/// A chapter holding a single image is the smallest unit the reader can page
/// through, and it keeps the table of contents honest: entry N is page N.
pub fn read_chapters(path: &Path) -> AppResult<Vec<RawChapter>> {
    let pages = page_entries(path)?;
    if pages.is_empty() {
        return Err(AppError::Parse("CBZ 压缩包里没有图片页".into()));
    }
    Ok(pages
        .into_iter()
        .enumerate()
        .map(|(index, entry)| RawChapter {
            title: Some(format!("第 {} 页", index + 1)),
            paragraphs: vec![format!("{IMAGE_PARAGRAPH_PREFIX}{entry}")],
        })
        .collect())
}

/// Page entry names in natural (numeric-aware) order.
///
/// Archives number pages as `1.jpg`, `2.jpg`, … `10.jpg`; a byte-wise sort
/// would read 10 before 2, so digit runs compare as numbers.
fn page_entries(path: &Path) -> AppResult<Vec<String>> {
    let file = std::fs::File::open(path)?;
    let archive = ZipArchive::new(file)
        .map_err(|err| AppError::Parse(format!("无法打开 CBZ 容器：{err}")))?;

    let mut pages: Vec<String> =
        archive.file_names().filter(|name| is_page(name)).map(|name| name.to_string()).collect();
    pages.sort_by(|a, b| natural_cmp(a, b));
    Ok(pages)
}

fn is_page(name: &str) -> bool {
    if name.ends_with('/') || name.starts_with('.') {
        return false;
    }
    // Resource forks and hidden directories inside the archive are not pages.
    const IGNORED_SEGMENTS: [&str; 2] = ["__MACOSX", ".git"];
    if name
        .split('/')
        .any(|segment| segment.starts_with('.') || IGNORED_SEGMENTS.contains(&segment))
    {
        return false;
    }
    matches!(extension_of(name).as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp")
}

fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Compares two strings chunk-wise: digit runs numerically, the rest byte-wise.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut left, mut right) = (a.as_bytes(), b.as_bytes());
    loop {
        match (left.first(), right.first()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (lx, rest_l) = take_digits(left);
                let (ly, rest_r) = take_digits(right);
                // Leading zeros are padding, not magnitude: `02` and `2` are the
                // same page number and stay tied so the sort keeps their order.
                let (sx, sy) = (significant(lx), significant(ly));
                let order = sx.len().cmp(&sy.len()).then_with(|| sx.cmp(sy));
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
                left = rest_l;
                right = rest_r;
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(y);
                }
                left = &left[1..];
                right = &right[1..];
            }
        }
    }
}

/// Drops the leading zeros of a digit run, so `007` compares as `7`.
fn significant(digits: &[u8]) -> &[u8] {
    let start = digits.iter().position(|byte| *byte != b'0').unwrap_or(digits.len().min(1));
    &digits[start..]
}

/// Splits the leading digit run off `bytes`.
fn take_digits(bytes: &[u8]) -> (&[u8], &[u8]) {
    let end = bytes.iter().position(|byte| !byte.is_ascii_digit()).unwrap_or(bytes.len());
    (&bytes[..end], &bytes[end..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::fixture;

    fn comic(dir: &Path, name: &str, pages: &[&str]) -> std::path::PathBuf {
        let bytes = fixture::png_bytes();
        let entries: Vec<(&str, &[u8])> =
            pages.iter().map(|page| (*page, bytes.as_slice())).collect();
        fixture::write_zip(dir, name, &entries)
    }

    #[test]
    fn pages_are_ordered_naturally_not_bytewise() {
        let dir = fixture::temp_dir("cbz-order");
        let path = comic(&dir, "book.cbz", &["page-10.png", "page-2.png", "page-1.png"]);

        let chapters = read_chapters(&path).expect("chapters");
        let titles: Vec<_> = chapters
            .iter()
            .map(|chapter| chapter.paragraphs[0].trim_start_matches(IMAGE_PARAGRAPH_PREFIX))
            .collect();
        assert_eq!(titles, ["page-1.png", "page-2.png", "page-10.png"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_images_and_hidden_files_are_not_pages() {
        let dir = fixture::temp_dir("cbz-filter");
        let path = fixture::write_zip(
            &dir,
            "book.cbz",
            &[
                ("001.png", fixture::png_bytes().as_slice()),
                ("ComicInfo.xml", b"<xml/>"),
                ("__MACOSX/002.png", fixture::png_bytes().as_slice()),
                (".hidden/003.png", fixture::png_bytes().as_slice()),
            ],
        );

        let chapters = read_chapters(&path).expect("chapters");
        assert_eq!(chapters.len(), 1, "{chapters:?}");
        assert_eq!(chapters[0].title.as_deref(), Some("第 1 页"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_first_page_becomes_the_cover() {
        let dir = fixture::temp_dir("cbz-cover");
        let path = comic(&dir, "book.cbz", &["002.png", "001.png"]);

        let metadata = read_metadata(&path).expect("metadata");
        let cover = metadata.cover.expect("封面必须取自第一页");
        assert_eq!(cover.extension, "png");
        assert_eq!(cover.bytes, fixture::png_bytes());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_archive_without_images_is_a_parse_error() {
        let dir = fixture::temp_dir("cbz-empty");
        let path = fixture::write_zip(&dir, "book.cbz", &[("readme.txt", b"nothing")]);

        assert!(read_chapters(&path).is_err());
        assert!(read_metadata(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn natural_order_sorts_numbers_before_filling_zeros() {
        let mut names = ["p10", "p2", "p02", "p1"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["p1", "p2", "p02", "p10"]);
    }
}
