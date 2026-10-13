//! Flattening dictionary markup into the text the popup shows.
//!
//! Both dictionary readers hand their payloads here: a StarDict field may be
//! Pango, HTML or PowerWord markup, and an MDX record is HTML. They carry the
//! same shapes — a tag, plus the handful of entities that actually appear in
//! dictionaries — so one implementation means one set of ceilings instead of two
//! that drift apart.

/// Drops tags and unescapes the entities that show up in dictionaries, then
/// trims — the result is display text, not a faithful flattening.
///
/// ponytail: not a parser. A `<` only starts a tag when a `>` follows soon and
/// the body looks like a tag name, so prose containing `a < b` keeps its tail;
/// anything more exotic than the common entities passes through as written. A
/// real HTML parser is a dependency this popup has not earned.
pub fn text_from_markup(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut position = 0;
    while position < chars.len() {
        if chars[position] == '<'
            && (chars[position + 1].is_ascii_alphabetic() || chars[position + 1] == '/')
            && let Some(close) =
                (position + 1..chars.len().min(position + 80)).find(|index| chars[*index] == '>')
        {
            let name: String = chars[position + 1..close].iter().collect();
            if is_break_tag(&name) {
                out.push('\n');
            }
            position = close + 1;
            continue;
        }
        out.push(chars[position]);
        position += 1;
    }
    // Flattening leaves the break from the last close tag behind, and the popup
    // never wants leading or trailing blank lines.
    unescape(&out).trim().to_string()
}

/// Whether a tag marks a line break in the flattened text.
///
/// A void element (`br`) has no close tag, so its opening one is the break; the
/// block elements break on their *close*, so opening one does not also add a
/// blank line of its own — `<div>上</div><div>下</div>` is two lines, not three.
fn is_break_tag(tag: &str) -> bool {
    let closing = tag.starts_with('/');
    let name = tag.trim_start_matches('/').split_whitespace().next().unwrap_or("");
    if name.eq_ignore_ascii_case("br") {
        return true;
    }
    closing && matches!(name.to_ascii_lowercase().as_str(), "p" | "div" | "li" | "tr")
}

/// Note the order: `&amp;` is decoded last so `&amp;lt;` becomes `&lt;` rather
/// than being unescaped twice into `<`.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_loses_its_tags_but_keeps_its_breaks() {
        assert_eq!(text_from_markup("<b>粗</b>体"), "粗体");
        assert_eq!(text_from_markup("一<br>二"), "一\n二");
        assert_eq!(text_from_markup("<span foreground=\"red\">红</span>"), "红");
        assert_eq!(text_from_markup("a &lt; b &amp;amp; c"), "a < b &amp; c");
        // A stray `<` that never opens a tag must not eat the rest of the line.
        assert_eq!(text_from_markup("2 < 3 是对的"), "2 < 3 是对的");
    }

    #[test]
    fn a_divider_becomes_a_line_break() {
        assert_eq!(text_from_markup("<div>上</div><div>下</div>"), "上\n下");
    }

    #[test]
    fn plain_text_is_untouched() {
        assert_eq!(text_from_markup("释义 1"), "释义 1");
    }
}
