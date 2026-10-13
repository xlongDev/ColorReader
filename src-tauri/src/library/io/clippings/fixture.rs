//! Test inputs shared across the module: an entry as Kindle writes one, and a
//! file as this app's own export writes one.

/// One entry, exactly as a Kindle writes it.
pub(super) fn entry(title: &str, meta: &str, body: &str) -> String {
    format!("{title}\n{meta}\n\n{body}\n==========\n")
}

/// A highlight entry, which is what most of the tests want.
pub(super) fn highlight(title: &str, body: &str) -> String {
    entry(
        title,
        "- Your Highlight on page 12 | Location 1234-1237 | Added on Monday, January 1, 2018 10:30:00 AM",
        body,
    )
}

/// A file as `export` writes it: blocks joined by a blank line, trailing
/// newline. Spelled out here rather than imported, so a change to the writer
/// that the reader does not follow fails in `export`'s own round trip, where
/// the pair is exercised for real.
pub(super) fn blocks(lines: &[&str]) -> String {
    format!("{}\n", lines.join("\n\n"))
}

pub(super) const LINK: &str = "colorreader://book/b1?annotation=a1";
