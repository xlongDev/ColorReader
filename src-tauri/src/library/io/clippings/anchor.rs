//! The two matches every clipping has to make: which book on the shelf it
//! belongs to ([`Catalog`]), and where inside that book its passage sits
//! ([`Haystack`]).
//!
//! A Kindle clippings file knows a highlight's *text* and a `位置 #1234-1237` line
//! number, and nothing else. That number counts positions inside the file Amazon
//! shipped, which is not the file we have: a re-imported AZW3, an EPUB from
//! elsewhere, a re-flowed TXT all number their positions differently. So the
//! text is the only anchor that survives, and that is what this file matches on
//! — every clipping is located by finding its text in the chapter bodies we
//! already store for full-text search. An export's own chapter number is a
//! better hint and is tried first (see [`locate`]); it is the one thing a Kindle
//! file cannot offer.
//!
//! Both matches ignore whitespace and the invisible characters the two sides
//! disagree about (Kindle drops the line breaks an EPUB splits a paragraph at;
//! extracted book text keeps soft hyphens the clipping does not have).
//! Everything else has to be identical, which it is: both sides are the same
//! sentence. The same reduced form is the de-duplication key, so importing the
//! same file twice adds nothing.

use rusqlite::{Connection, params};

use crate::error::AppResult;

/// Characters that carry no ink of their own and that the two sides of a match
/// may legitimately disagree about.
fn ignorable(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(ch, '\u{00ad}' | '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}')
}

/// A chapter body reduced once, then searched by every clipping of that book.
///
/// [`locate`]: Haystack::locate
pub struct Haystack {
    /// The text with the ignorable characters taken out, one entry per UTF-16
    /// code unit (annotation offsets are UTF-16, so these are too).
    units: Vec<u16>,
    /// The original UTF-16 span each unit came from, parallel to `units`.
    spans: Vec<(u32, u32)>,
}

impl Haystack {
    fn new(text: &str) -> Self {
        let mut units = Vec::with_capacity(text.len());
        let mut spans = Vec::with_capacity(text.len());
        let mut at = 0u32;
        let mut buf = [0u16; 2];
        for ch in text.chars() {
            if !ignorable(ch) {
                for (offset, unit) in ch.encode_utf16(&mut buf).iter().enumerate() {
                    units.push(*unit);
                    let start = at + offset as u32;
                    spans.push((start, start + 1));
                }
            }
            at += ch.len_utf16() as u32;
        }
        Self { units, spans }
    }

    /// The UTF-16 range `needle` occupies in the original text, if it is there.
    fn locate(&self, needle: &str) -> Option<(usize, usize)> {
        let mut wanted: Vec<u16> = Vec::with_capacity(needle.len());
        let mut buf = [0u16; 2];
        for ch in needle.chars() {
            if ignorable(ch) {
                continue;
            }
            let len = ch.encode_utf16(&mut buf).len();
            wanted.extend_from_slice(&buf[..len]);
        }
        if wanted.is_empty() || wanted.len() > self.units.len() {
            return None;
        }
        let at = self.units.windows(wanted.len()).position(|window| window == wanted)?;
        Some((self.spans[at].0 as usize, self.spans[at + wanted.len() - 1].1 as usize))
    }
}

/// Comparison key for "the same highlight, twice": case- and
/// whitespace-insensitive, so a re-imported file and the rows already stored
/// agree even though one side has line breaks where the other has spaces.
pub fn signature(text: &str) -> String {
    text.chars().filter(|ch| !ignorable(*ch)).flat_map(char::to_lowercase).collect()
}

/// The shelf, indexed for title lookup.
pub struct Catalog {
    entries: Vec<Entry>,
}

struct Entry {
    id: String,
    key: String,
    authors: String,
}

impl Catalog {
    pub fn new(books: impl IntoIterator<Item = (String, String, String)>) -> Self {
        let entries = books
            .into_iter()
            .map(|(id, title, authors)| Entry {
                id,
                key: signature(&title),
                authors: signature(&authors),
            })
            .collect();
        Self { entries }
    }

    /// The book a clipping came from, or `None` when the shelf has no
    /// unambiguous candidate.
    pub fn lookup(&self, title: &str, author: &str) -> Option<&str> {
        let key = signature(title);
        if key.is_empty() {
            return None;
        }
        let author = signature(author);

        // An identical title is strong evidence, so it wins even when the shelf
        // holds the book twice; the author only decides between two books that
        // share the title.
        let exact: Vec<&Entry> = self.entries.iter().filter(|entry| entry.key == key).collect();
        if let Some(entry) = by_author(&exact, &author).or_else(|| exact.first().copied()) {
            return Some(entry.id.as_str());
        }

        // Otherwise Kindle's title carries something the shelf dropped, or the
        // other way round: `Sapiens: A Brief History of Humankind` against
        // `Sapiens`. Only one direction of prefix, and never on a stub of a
        // title, or short books would match each other.
        let guessed: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|entry| {
                let (short, long) = if entry.key.chars().count() <= key.chars().count() {
                    (&entry.key, &key)
                } else {
                    (&key, &entry.key)
                };
                short.chars().count() >= 6 && long.starts_with(short.as_str())
            })
            .collect();
        if guessed.len() == 1 {
            return Some(guessed[0].id.as_str());
        }
        by_author(&guessed, &author).map(|entry| entry.id.as_str())
    }
}

/// The unique candidate the author points at, if there is one.
fn by_author<'a>(candidates: &[&'a Entry], author: &str) -> Option<&'a Entry> {
    if author.is_empty() {
        return None;
    }
    let mut matches = candidates.iter().filter(|entry| {
        !entry.authors.is_empty()
            && (entry.authors.contains(author) || author.contains(entry.authors.as_str()))
    });
    let first = *matches.next()?;
    matches.next().is_none().then_some(first)
}

/// Every chapter body of a book, ready to be searched.
pub fn chapter_haystacks(
    conn: &Connection,
    book_id: &str,
) -> AppResult<Option<Vec<(usize, Haystack)>>> {
    let mut stmt =
        conn.prepare("SELECT idx, content FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
    let mut rows = stmt.query(params![book_id])?;
    let mut chapters = Vec::new();
    while let Some(row) = rows.next()? {
        // `idx` is an integer column; annotation rows carry it as a `usize`.
        let idx = row.get::<_, i64>(0)?.max(0) as usize;
        let content = row.get::<_, String>(1)?;
        chapters.push((idx, Haystack::new(&content)));
    }
    Ok((!chapters.is_empty()).then_some(chapters))
}

/// The chapter holding this text, if any.
///
/// `hint` is the chapter the file itself named, and it is tried first. That
/// matters twice over: it is one chapter searched instead of every one, and it
/// settles the case a text-only search cannot — a sentence that appears in two
/// chapters should anchor in the one the reader actually marked.
pub fn locate(
    chapters: &[(usize, Haystack)],
    needle: &str,
    hint: Option<usize>,
) -> Option<(usize, usize, usize)> {
    if let Some(hint) = hint
        && let Some((idx, haystack)) = chapters.iter().find(|(idx, _)| *idx == hint)
        && let Some((start, end)) = haystack.locate(needle)
    {
        return Some((*idx, start, end));
    }
    for (idx, haystack) in chapters {
        if let Some((start, end)) = haystack.locate(needle) {
            return Some((*idx, start, end));
        }
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locating_ignores_the_whitespace_the_two_sides_disagree_about() {
        // The book breaks the paragraph; the clipping does not.
        let haystack = Haystack::new("and the House\n  said:  hello");
        assert_eq!(haystack.locate("the House said: hello"), Some((4, 28)));
        assert_eq!(haystack.locate("nothing here"), None);
        assert_eq!(haystack.locate(""), None);
    }

    #[test]
    fn locating_survives_soft_hyphens_the_clipping_lacks() {
        let haystack = Haystack::new("imme\u{00ad}asurable");
        assert_eq!(haystack.locate("immeasurable"), Some((0, 13)));
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        // Each of these is one character but two UTF-16 units, so a byte- or
        // char-counted offset would be half of the real one.
        let haystack = Haystack::new("中文切分");
        assert_eq!(haystack.locate("切分"), Some((2, 4)));
    }

    #[test]
    fn a_catalog_prefers_the_author_when_a_title_repeats() {
        let catalog = Catalog::new(vec![
            ("a".into(), "Piranesi".into(), "Susanna Clarke".into()),
            ("b".into(), "Piranesi".into(), "Someone Else".into()),
        ]);
        assert_eq!(catalog.lookup("Piranesi", "Susanna Clarke"), Some("a"));
        assert_eq!(catalog.lookup("Piranesi", "Someone Else"), Some("b"));
        // No author to go on: an identical title still beats no match at all.
        assert_eq!(catalog.lookup("Piranesi", ""), Some("a"));
    }

    #[test]
    fn a_catalog_matches_a_subtitle_the_shelf_dropped() {
        let catalog =
            Catalog::new(vec![("a".into(), "Sapiens".into(), "Yuval Noah Harari".into())]);
        assert_eq!(
            catalog.lookup("Sapiens: A Brief History of Humankind", "Yuval Noah Harari"),
            Some("a")
        );
        assert_eq!(catalog.lookup("Sapie", ""), None);
        assert_eq!(catalog.lookup("", ""), None);
    }

    #[test]
    fn a_short_title_does_not_match_a_longer_one() {
        let catalog = Catalog::new(vec![("a".into(), "War".into(), "".into())]);
        assert_eq!(catalog.lookup("War and Peace", ""), None);
    }

    #[test]
    fn an_ambiguous_prefix_matches_nothing() {
        // Both titles are a prefix of the clipping's, so the fallback has no
        // way to choose and must not guess.
        let catalog = Catalog::new(vec![
            ("a".into(), "The Great Book".into(), "".into()),
            ("b".into(), "The Great Book of Everything".into(), "".into()),
        ]);
        assert_eq!(catalog.lookup("The Great Book of Everything and More", ""), None);
        assert_eq!(catalog.lookup("The Great Book of Everything Else", "Somebody Else"), None);
    }
}
