//! Plain text and Markdown metadata and chapter splitting.
//!
//! There is no embedded metadata in these formats, so the file name is the
//! source of truth. Markdown gets one extra courtesy: an H1 on the first line
//! beats a file name like `chapter-01`.
//!
//! Chapters are recovered from headings: Markdown splits on ATX headings, plain
//! text on "第N章"-style chapter markers. When neither yields a break, the whole
//! file becomes a single chapter.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use super::{BookFormat, BookMetadata, RawChapter};
use crate::error::AppResult;

/// How much of the file to scan for a Markdown heading.
const HEADING_SCAN_BYTES: u64 = 8 * 1024;

/// A chapter marker line longer than this is prose, not a heading.
const MAX_HEADING_CHARS: usize = 60;

pub fn read_metadata(path: &Path, format: BookFormat) -> AppResult<BookMetadata> {
    let title = if format == BookFormat::Markdown {
        first_heading(path).unwrap_or_else(|| title_from_stem(path))
    } else {
        title_from_stem(path)
    };
    Ok(BookMetadata { title, ..BookMetadata::default() })
}

/// Splits a plain text or Markdown file into chapters.
pub fn read_chapters(path: &Path, format: BookFormat) -> AppResult<Vec<RawChapter>> {
    let file = std::fs::File::open(path)?;
    let reader = BufReader::new(file);

    let mut chapters: Vec<RawChapter> = Vec::new();
    let mut current = RawChapter::default();

    for line in reader.lines() {
        let line = line.unwrap_or_default();
        let trimmed = line.trim();

        // A heading line opens a new chapter; everything before it already sits
        // in `current`.
        let heading = match format {
            BookFormat::Markdown => markdown_heading(trimmed),
            BookFormat::Text => text_heading(trimmed),
            BookFormat::Epub => unreachable!("EPUB chapters are parsed separately"),
        };

        if let Some(title) = heading {
            if !current.paragraphs.is_empty() || current.title.is_some() {
                chapters.push(std::mem::take(&mut current));
            }
            current.title = Some(title);
            continue;
        }

        if trimmed.is_empty() {
            continue;
        }

        current.paragraphs.push(trimmed.to_string());
    }

    if !current.paragraphs.is_empty() || current.title.is_some() {
        chapters.push(current);
    }

    // A file with no headings at all still reads as one chapter.
    if chapters.is_empty() {
        return Ok(vec![RawChapter::default()]);
    }
    Ok(chapters)
}

/// ATX heading (`# `, `## `, ...) → its text, or `None` for a normal line.
fn markdown_heading(line: &str) -> Option<String> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    // CommonMark requires whitespace between the hashes and the text; `#tag` is
    // a tag, not a heading.
    if line.chars().nth(hashes) != Some(' ') {
        return None;
    }
    let rest = line.get(hashes..)?.trim();
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_string())
}

/// Detects "第N章 / Chapter N"-style chapter markers.
fn text_heading(line: &str) -> Option<String> {
    if line.chars().count() > MAX_HEADING_CHARS {
        return None;
    }
    let is_chinese = line.starts_with('第')
        && line.chars().nth(1).is_some_and(|c| c.is_ascii_digit() || is_chinese_numeral(c))
        && ['章', '节', '卷', '回', '部', '集'].iter().any(|marker| line.contains(*marker));
    let is_english = {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("chapter")
            && lower["chapter".len()..].trim_start().starts_with(|c: char| c.is_ascii_digit())
    };
    (is_chinese || is_english).then(|| line.to_string())
}

/// Chinese numerals used in chapter numbering.
fn is_chinese_numeral(c: char) -> bool {
    matches!(
        c,
        '〇' | '零'
            | '一'
            | '二'
            | '三'
            | '四'
            | '五'
            | '六'
            | '七'
            | '八'
            | '九'
            | '十'
            | '百'
            | '千'
            | '万'
    )
}

/// File name without extension, used as the title of last resort.
pub fn title_from_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .unwrap_or("未命名")
        .to_string()
}

/// The H1 on the first non-empty line, if the file opens with one.
fn first_heading(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(HEADING_SCAN_BYTES).read_to_end(&mut buffer).ok()?;

    // Lossy on purpose: a GB18030 text file must still import, and a garbled
    // heading is no worse than falling back to the file name.
    let head = String::from_utf8_lossy(&buffer);
    let line = head.lines().map(str::trim).find(|line| !line.is_empty())?;
    let title = line.strip_prefix('#')?.trim();
    (!title.is_empty()).then(|| title.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::fixture;

    #[test]
    fn txt_titles_come_from_the_file_name() {
        let dir = fixture::temp_dir("plain");
        let path = dir.join("三体.txt");
        std::fs::write(&path, "正文").expect("write");

        let metadata = read_metadata(&path, BookFormat::Text).expect("read");
        assert_eq!(metadata.title, "三体");
        assert!(metadata.authors.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn markdown_prefers_the_first_heading() {
        let dir = fixture::temp_dir("md");
        let path = dir.join("chapter-01.md");
        std::fs::write(&path, "# 第一章\n\n正文").expect("write");

        let metadata = read_metadata(&path, BookFormat::Markdown).expect("read");
        assert_eq!(metadata.title, "第一章");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn markdown_without_a_heading_falls_back_to_the_file_name() {
        let dir = fixture::temp_dir("md2");
        let path = dir.join("notes.md");
        std::fs::write(&path, "随便一段话").expect("write");

        let metadata = read_metadata(&path, BookFormat::Markdown).expect("read");
        assert_eq!(metadata.title, "notes");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_nameless_path_still_gets_a_title() {
        assert_eq!(title_from_stem(Path::new("/")), "未命名");
    }

    #[test]
    fn markdown_splits_on_atx_headings() {
        let dir = fixture::temp_dir("md-chapters");
        let path = dir.join("book.md");
        std::fs::write(&path, "# 第一章\n\n正文甲\n\n## 第一节\n\n正文乙\n\n没有井号的行\n")
            .expect("write");

        let chapters = read_chapters(&path, BookFormat::Markdown).expect("read");
        assert_eq!(chapters.len(), 2, "{chapters:?}");
        assert_eq!(chapters[0].title.as_deref(), Some("第一章"));
        assert_eq!(chapters[0].paragraphs, ["正文甲"]);
        assert_eq!(chapters[1].title.as_deref(), Some("第一节"));
        assert_eq!(chapters[1].paragraphs, ["正文乙", "没有井号的行"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn text_splits_on_chapter_markers() {
        let dir = fixture::temp_dir("txt-chapters");
        let path = dir.join("book.txt");
        std::fs::write(&path, "第一章 开始\n\n正文甲\n\n第二章 继续\n\n正文乙\n").expect("write");

        let chapters = read_chapters(&path, BookFormat::Text).expect("read");
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title.as_deref(), Some("第一章 开始"));
        assert_eq!(chapters[1].title.as_deref(), Some("第二章 继续"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn text_without_markers_is_a_single_chapter() {
        let dir = fixture::temp_dir("txt-flat");
        let path = dir.join("book.txt");
        std::fs::write(&path, "第一行\n\n第二行\n").expect("write");

        let chapters = read_chapters(&path, BookFormat::Text).expect("read");
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, None);
        assert_eq!(chapters[0].paragraphs, ["第一行", "第二行"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_prose_line_starting_with_di_is_not_a_heading() {
        let dir = fixture::temp_dir("txt-false-positive");
        let path = dir.join("book.txt");
        // Starts with "第一" but carries no chapter marker, so it is prose.
        std::fs::write(&path, "第一缕阳光洒在窗台上，新的一天开始了。\n").expect("write");

        let chapters = read_chapters(&path, BookFormat::Text).expect("read");
        assert_eq!(chapters.len(), 1, "无标记的普通句不应被拆章");
        assert_eq!(chapters[0].title, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_overlong_marker_line_is_prose_not_a_heading() {
        let dir = fixture::temp_dir("txt-long");
        let path = dir.join("book.txt");
        let long = format!("第一章{}", "长".repeat(80));
        std::fs::write(&path, long).expect("write");

        let chapters = read_chapters(&path, BookFormat::Text).expect("read");
        assert_eq!(chapters.len(), 1, "超长行不应被当成分章标题");
        assert_eq!(chapters[0].title, None);

        std::fs::remove_dir_all(&dir).ok();
    }
}
