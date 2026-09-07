//! Streaming XHTML → plain-text blocks, shared by every HTML-carrying format.
//!
//! EPUB feeds this one spine document at a time and resolves in-book links
//! afterwards; MOBI/KF8 feeds it the whole book and splits on headings. Both
//! get identical paragraph, heading and image semantics from one parser.

use quick_xml::escape::unescape;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use super::{IMAGE_PARAGRAPH_PREFIX, LINK_FIELD_SEPARATOR, LINK_PARAGRAPH_PREFIX, RawChapter};

/// One piece of a converted document, in document order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    Heading(String),
    Paragraph(String),
}

/// Converts an XHTML document into ordered blocks.
///
/// Style and script contents are dropped, block boundaries become paragraph
/// breaks, and images become marker paragraphs (see
/// [`IMAGE_PARAGRAPH_PREFIX`]) whose payload is the archive entry path resolved
/// against `base_dir`. Internal links become [`LINK_PARAGRAPH_PREFIX`] marker
/// paragraphs whose target is the document path; the caller rewrites them to
/// chapter indices once it knows the chapter order (a MOBI has no document
/// paths at all, so its links degrade to plain text).
///
/// This never loads the document as a DOM: it is a single forward pass.
pub fn parse_html(html: &str, base_dir: &str) -> Vec<Block> {
    let mut reader = Reader::from_str(html);
    let mut buf = Vec::new();
    let mut blocks: Vec<Block> = Vec::new();
    let mut current = String::new();
    let mut heading = String::new();
    let mut in_heading = false;
    // Tag whose contents we are skipping, if any.
    let mut skip: Option<String> = None;
    // Resolved target of the `<a href>` currently open, if it is internal.
    let mut link_target: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) => {
                let tag = element.name().local_name().as_ref().to_string();
                // EPUB cover pages are usually `<svg><image xlink:href/></svg>`;
                // the svg skip must not swallow the one reference that matters.
                if tag == "image" && skip.as_deref() == Some("svg") {
                    push_image(&mut blocks, base_dir, &element);
                    continue;
                }
                if skip.is_some() {
                    continue;
                }
                if is_skipped(&tag) {
                    skip = Some(tag);
                } else if tag == "img" || tag == "image" {
                    push_text(&mut blocks, &mut current, false);
                    push_image(&mut blocks, base_dir, &element);
                } else if is_heading(&tag) {
                    push_text(&mut blocks, &mut current, false);
                    heading.clear();
                    in_heading = true;
                } else if tag == "a" {
                    let href = attribute(&element, "href");
                    if is_internal_href(&href) {
                        push_text(&mut blocks, &mut current, false);
                        // Only the document path matters; chapter-level jumps.
                        let mut target = super::resolve_href(base_dir, &href);
                        if let Some(pos) = target.find('#') {
                            target.truncate(pos);
                        }
                        link_target = Some(target);
                    }
                }
            }
            Ok(Event::Empty(element)) => {
                let tag = element.name().local_name().as_ref().to_string();
                if tag == "image" && skip.as_deref() == Some("svg") {
                    push_image(&mut blocks, base_dir, &element);
                    continue;
                }
                if skip.is_some() {
                    continue;
                }
                // A line break ends a paragraph but carries no text itself.
                if tag == "br" {
                    push_text(&mut blocks, &mut current, false);
                } else if tag == "img" || tag == "image" {
                    push_text(&mut blocks, &mut current, false);
                    push_image(&mut blocks, base_dir, &element);
                }
            }
            Ok(Event::End(element)) => {
                let tag = element.name().local_name().as_ref().to_string();
                if let Some(skip_tag) = &skip {
                    if *skip_tag == tag {
                        skip = None;
                    }
                    continue;
                }
                if is_heading(&tag) {
                    if in_heading {
                        let text = normalise(&heading);
                        heading.clear();
                        if !text.is_empty() {
                            blocks.push(Block::Heading(text));
                        }
                        in_heading = false;
                    }
                } else if tag == "a" && link_target.is_some() {
                    let text = take_normalised(&mut current);
                    if let Some(target) = link_target.take()
                        && !text.is_empty()
                    {
                        blocks.push(Block::Paragraph(format!(
                            "{LINK_PARAGRAPH_PREFIX}{target}{LINK_FIELD_SEPARATOR}{text}"
                        )));
                    }
                } else if is_block(&tag) {
                    push_text(&mut blocks, &mut current, false);
                }
            }
            Ok(Event::Text(element)) => {
                if skip.is_some() {
                    continue;
                }
                let Ok(text) = unescape(&element) else { continue };
                if in_heading {
                    heading.push_str(&text);
                } else {
                    current.push_str(&text);
                }
            }
            Ok(Event::CData(element)) => {
                if skip.is_none() && !in_heading {
                    current.push_str(element.as_ref());
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    push_text(&mut blocks, &mut current, false);
    blocks
}

/// Collapses all blocks into one chapter; the first heading becomes the title.
///
/// A heading also contributes a paragraph, so it reads as part of the page.
pub fn chapter_from_blocks(blocks: Vec<Block>) -> RawChapter {
    let mut chapter = RawChapter::default();
    for block in blocks {
        match block {
            Block::Heading(text) => {
                if chapter.title.is_none() {
                    chapter.title = Some(text.clone());
                }
                chapter.paragraphs.push(text);
            }
            Block::Paragraph(text) => chapter.paragraphs.push(text),
        }
    }
    chapter
}

/// Splits blocks into one chapter per heading, preserving reading order.
///
/// MOBI and KF8 ship the whole book as a single HTML document with no container
/// to split on, so the headings are the only structure available. Blocks before
/// the first heading become a leading chapter.
pub fn chapters_from_blocks(blocks: Vec<Block>) -> Vec<RawChapter> {
    let mut chapters: Vec<RawChapter> = Vec::new();
    let mut current = RawChapter::default();
    for block in blocks {
        match block {
            Block::Heading(text) => {
                if !current.paragraphs.is_empty() {
                    chapters.push(std::mem::take(&mut current));
                }
                current.title = Some(text.clone());
                current.paragraphs.push(text);
            }
            Block::Paragraph(text) => current.paragraphs.push(text),
        }
    }
    if !current.paragraphs.is_empty() {
        chapters.push(current);
    }
    chapters
}

/// Elements whose contents are not prose and must not leak into paragraphs.
fn is_skipped(tag: &str) -> bool {
    matches!(tag, "style" | "script" | "head" | "svg" | "math")
}

/// A document heading: also the chapter break for whole-book HTML.
fn is_heading(tag: &str) -> bool {
    matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

/// Block elements whose close ends a paragraph.
fn is_block(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "div"
            | "li"
            | "blockquote"
            | "tr"
            | "td"
            | "th"
            | "section"
            | "article"
            | "pre"
            | "figure"
            | "figcaption"
            | "header"
            | "footer"
            | "aside"
            | "main"
            | "ul"
            | "ol"
            | "table"
            | "body"
            | "html"
    )
}

/// Reads an attribute by local name, ignoring any namespace prefix.
pub fn attribute(element: &BytesStart<'_>, key: &str) -> String {
    element
        .attributes()
        .flatten()
        .find(|attr| attr.key.local_name().as_ref() == key)
        .and_then(|attr| unescape(&attr.value).ok().map(|value| value.trim().to_owned()))
        .unwrap_or_default()
}

/// True for hrefs that can resolve to another spine document: not empty, not
/// a same-document fragment, and not an external scheme.
fn is_internal_href(href: &str) -> bool {
    let href = href.trim();
    !href.is_empty()
        && !href.starts_with('#')
        && !href.to_ascii_lowercase().starts_with("http")
        && !href.to_ascii_lowercase().starts_with("mailto:")
}

/// Appends an image reference as its own marker block.
fn push_image(blocks: &mut Vec<Block>, base_dir: &str, element: &BytesStart<'_>) {
    let mut src = attribute(element, "src");
    if src.is_empty() {
        // SVG `<image>` carries the reference on xlink:href.
        src = attribute(element, "href");
    }
    if src.is_empty() {
        return;
    }
    let entry = super::resolve_href(base_dir, &src);
    if !entry.is_empty() {
        blocks.push(Block::Paragraph(format!("{IMAGE_PARAGRAPH_PREFIX}{entry}")));
    }
}

/// Flushes the buffered text run as a block, dropping empty runs.
fn push_text(blocks: &mut Vec<Block>, current: &mut String, heading: bool) {
    let text = take_normalised(current);
    if text.is_empty() {
        return;
    }
    blocks.push(if heading { Block::Heading(text) } else { Block::Paragraph(text) });
}

/// Trims and collapses the buffer, returning and clearing it.
fn take_normalised(current: &mut String) -> String {
    let text = normalise(current);
    current.clear();
    text
}

/// Collapses whitespace runs into single spaces.
fn normalise(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_is_turned_into_paragraphs_with_a_heading_title() {
        let html = r#"<html><head><style>.x{}</style><title>忽略</title></head><body>
          <h1>第一章  引子</h1>
          <p>第一段内容</p>
          <p>第二段内容</p>
          <script>var a = 1;</script>
          <p>第三段</p>
        </body></html>"#;

        let chapter = chapter_from_blocks(parse_html(html, "OEBPS/text"));
        assert_eq!(chapter.title.as_deref(), Some("第一章 引子"));
        assert_eq!(chapter.paragraphs, ["第一章 引子", "第一段内容", "第二段内容", "第三段"]);
    }

    #[test]
    fn an_image_becomes_a_marker_block_with_a_resolved_entry() {
        let html = r#"<html><body>
          <p>图前文字</p>
          <img src="../images/plot.png" alt=""/>
          <p>图后文字</p>
        </body></html>"#;

        assert_eq!(
            parse_html(html, "OEBPS/text"),
            [
                Block::Paragraph("图前文字".into()),
                Block::Paragraph("\u{FFFC}OEBPS/images/plot.png".into()),
                Block::Paragraph("图后文字".into()),
            ]
        );
    }

    #[test]
    fn an_image_inside_svg_becomes_a_marker_block() {
        let html = r#"<html xmlns="http://www.w3.org/1999/xhtml">
          <body><svg viewBox="0 0 1 1"><image xlink:href="cover.jpg"/></svg></body>
        </html>"#;

        assert_eq!(parse_html(html, "OEBPS"), [Block::Paragraph("\u{FFFC}OEBPS/cover.jpg".into())]);
    }

    #[test]
    fn internal_links_become_markers_and_external_ones_stay_text() {
        let html = r##"<html><body>
          <p><a href="ch3.xhtml">雕刻时光</a></p>
          <p><a href="text/ch4.xhtml#p2">使命与命运</a></p>
          <p><a href="https://example.com">外链</a></p>
          <p><a href="#note">同文档</a></p>
        </body></html>"##;

        assert_eq!(
            parse_html(html, "text"),
            [
                Block::Paragraph("\u{FFFB}text/ch3.xhtml\u{1F}雕刻时光".into()),
                Block::Paragraph("\u{FFFB}text/text/ch4.xhtml\u{1F}使命与命运".into()),
                Block::Paragraph("外链".into()),
                Block::Paragraph("同文档".into()),
            ]
        );
    }

    #[test]
    fn headings_split_whole_book_html_into_chapters() {
        let html =
            "<html><body><p>序</p><h1>甲</h1><p>正文甲</p><h2>乙</h2><p>正文乙</p></body></html>";

        let chapters = chapters_from_blocks(parse_html(html, ""));
        assert_eq!(chapters.len(), 3, "{chapters:?}");
        assert_eq!(chapters[0].title, None);
        assert_eq!(chapters[0].paragraphs, ["序"]);
        assert_eq!(chapters[1].title.as_deref(), Some("甲"));
        assert_eq!(chapters[2].title.as_deref(), Some("乙"));
        assert_eq!(chapters[2].paragraphs, ["乙", "正文乙"]);
    }

    #[test]
    fn cdata_text_is_kept_and_headings_stay_out_of_it() {
        let html = "<html><body><p><![CDATA[被 CDATA 包裹的文字]]></p></body></html>";
        assert_eq!(parse_html(html, ""), [Block::Paragraph("被 CDATA 包裹的文字".into())]);
    }
}
