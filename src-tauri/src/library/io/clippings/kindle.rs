//! Kindle's `My Clippings.txt`: one entry per run of `=`, three kinds of entry.
//!
//! The device writes a title line, a `- Your Highlight on page …` metadata
//! line and the passage, and pads the lot with blank lines. Only the highlight
//! kind carries a passage, so notes and bookmarks are counted and dropped here
//! rather than carried into [`super::Parsed`] to be dropped later. An entry
//! whose second line is not shaped like one is skipped rather than guessed at:
//! the file is written by a device the reader cannot fix.
//!
//! What a Kindle entry can and cannot say — and why the passage, not the
//! location number, is the anchor — is the parent module's story.

use super::{Clipping, Parsed};

/// The separator Kindle writes between entries.
const SEPARATOR: char = '=';

/// Shortest run of `=` that counts as a separator. Kindle writes ten; being
/// lenient here costs nothing and survives files other tools rewrote.
const SEPARATOR_RUN: usize = 8;

/// Which of the three things Kindle records an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Highlight,
    Note,
    Bookmark,
    Unknown,
}

/// Reads a clippings file. Never fails: a malformed entry is skipped, because
/// the file is written by a device the reader cannot fix.
pub fn parse(source: &str) -> Parsed {
    // Kindle writes a BOM, and line endings depend on the device and on
    // whichever machine the file was copied through.
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let normalised = source.replace("\r\n", "\n").replace('\r', "\n");

    let mut parsed = Parsed::default();
    let mut entry: Vec<&str> = Vec::new();
    for line in normalised.lines() {
        if is_separator(line) {
            read_entry(&entry, &mut parsed);
            entry.clear();
            continue;
        }
        entry.push(line);
    }
    read_entry(&entry, &mut parsed);
    parsed
}

fn is_separator(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.chars().count() < SEPARATOR_RUN {
        return false;
    }
    trimmed.chars().all(|ch| ch == SEPARATOR)
}

/// Reads one entry into `parsed`, ignoring it when it is a note/bookmark or is
/// not shaped like a clippings entry at all.
fn read_entry(lines: &[&str], parsed: &mut Parsed) {
    // Kindle pads the block with blank lines around the separator.
    let lines: Vec<&str> = lines.iter().copied().map(str::trim).collect();
    let Some(start) = lines.iter().position(|line| !line.is_empty()) else {
        return;
    };
    let lines = &lines[start..];
    if lines.len() < 2 || !lines[1].starts_with('-') {
        return;
    }

    match kind(lines[1]) {
        Kind::Highlight => {}
        Kind::Note => {
            parsed.notes += 1;
            return;
        }
        Kind::Bookmark => {
            parsed.bookmarks += 1;
            return;
        }
        // A line the device wrote in a shape we do not know is not worth
        // guessing at.
        Kind::Unknown => return,
    }

    let text = collapse(&lines[2..].join("\n"));
    if text.is_empty() {
        return;
    }
    let (title, author) = split_title_author(lines[0]);
    parsed.highlights.push(Clipping { title, author, text, ..Clipping::default() });
}

fn kind(meta: &str) -> Kind {
    let ascii = meta.to_ascii_lowercase();
    if ascii.contains("bookmark") || meta.contains("书签") {
        return Kind::Bookmark;
    }
    if ascii.contains("note") || meta.contains("笔记") {
        return Kind::Note;
    }
    if ascii.contains("highlight") || meta.contains("标注") || meta.contains("高亮") {
        return Kind::Highlight;
    }
    Kind::Unknown
}

/// Squeezes every whitespace run — including the line breaks Kindle keeps
/// inside a multi-paragraph highlight — into a single space.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            gap = !out.is_empty();
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(ch);
    }
    out
}

/// Splits Kindle's `Title (Author)` line. The author is the trailing
/// parenthesised group, so a title carrying parentheses of its own still
/// splits in the right place; a line without one is all title.
fn split_title_author(line: &str) -> (String, String) {
    let line = line.trim();
    if let Some(open) = line.strip_suffix(')').and_then(|head| head.rfind('(')) {
        let title = line[..open].trim();
        let author = line[open + 1..line.len() - 1].trim();
        if !title.is_empty() && !author.is_empty() {
            return (title.to_string(), author.to_string());
        }
    }
    (line.to_string(), String::new())
}

#[cfg(test)]
mod tests {
    use super::super::fixture::{entry, highlight};
    use super::*;

    #[test]
    fn parses_highlights_and_counts_the_rest() {
        let source = format!(
            "{}{}{}",
            highlight("Sapiens (Yuval Noah Harari)", "The first sentence."),
            entry(
                "Sapiens (Yuval Noah Harari)",
                "- Your Note on page 12 | Location 1240 | Added on Monday, January 1, 2018 10:31:00 AM",
                "My own thought."
            ),
            entry(
                "Sapiens (Yuval Noah Harari)",
                "- Your Bookmark on page 40 | Location 4000 | Added on Monday, January 1, 2018 11:00:00 AM",
                ""
            ),
        );
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "The first sentence.");
        assert_eq!(parsed.highlights[0].title, "Sapiens");
        assert_eq!(parsed.highlights[0].author, "Yuval Noah Harari");
        assert_eq!(parsed.notes, 1);
        assert_eq!(parsed.bookmarks, 1);
    }

    #[test]
    fn a_bom_and_crlf_do_not_get_in_the_way() {
        let source = format!(
            "\u{feff}{}",
            highlight("Piranesi (Susanna Clarke)", "The Beauty of the House is immeasurable.")
        )
        .replace('\n', "\r\n");
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].title, "Piranesi");
        assert_eq!(parsed.highlights[0].text, "The Beauty of the House is immeasurable.");
    }

    #[test]
    fn the_last_entry_needs_no_trailing_separator() {
        let source = "Piranesi (Susanna Clarke)\n- Your Highlight at location 1-2 | Added on Monday, January 1, 2018 10:30:00 AM\n\nA last line.\n";
        let parsed = parse(source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "A last line.");
    }

    #[test]
    fn a_multi_paragraph_highlight_is_one_entry() {
        let source =
            highlight("Piranesi (Susanna Clarke)", "First paragraph.\n\nSecond paragraph.");
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "First paragraph. Second paragraph.");
    }

    #[test]
    fn a_ragged_file_is_skipped_not_fatal() {
        let source = format!(
            "junk without a metadata line\n\nnoise\n==========\n{}",
            highlight("Piranesi (Susanna Clarke)", "The real one.")
        );
        let parsed = parse(&source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "The real one.");
    }

    #[test]
    fn titles_split_at_the_trailing_parenthesis() {
        assert_eq!(
            split_title_author("The Art of War (Illustrated) (Sun Tzu)"),
            ("The Art of War (Illustrated)".into(), "Sun Tzu".into())
        );
        assert_eq!(
            split_title_author("Piranesi (Susanna Clarke)"),
            ("Piranesi".into(), "Susanna Clarke".into())
        );
        assert_eq!(
            split_title_author("An Anonymous Book"),
            ("An Anonymous Book".into(), "".into())
        );
        // Kindle separates the two with a space, so a title that itself ends in
        // parentheses and a title with an author are the same line. The format
        // wins: an author is far more common than a book whose title ends in a
        // bracket, and the split keeps the author available for matching.
        assert_eq!(split_title_author("What (is this)"), ("What".into(), "is this".into()));
    }
}
