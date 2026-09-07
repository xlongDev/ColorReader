//! FictionBook 2.x: metadata, body sections and inline base64 images.
//!
//! FB2 is XML with the images carried inline as `<binary>` base64 blocks, so
//! unlike EPUB there is no archive to address. Image references are recorded as
//! `#<binary id>` marker paragraphs (see [`IMAGE_PARAGRAPH_PREFIX`]) and the
//! bytes are decoded on demand by `book.asset`, which keeps a chapter with no
//! pictures from paying for a full scan of the file.

use std::io::Read;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::reader::Reader;

use super::html::attribute;
use super::{BookMetadata, CoverImage, IMAGE_PARAGRAPH_PREFIX, RawChapter};
use crate::error::{AppError, AppResult};

/// Refuse to buffer more than this for a FictionBook document. Real ones with
/// inlined images run to a few tens of megabytes at worst.
const MAX_DOCUMENT_BYTES: u64 = 128 * 1024 * 1024;

/// Refuse to buffer more than this for a single inlined image.
const MAX_BINARY_BYTES: u64 = 20 * 1024 * 1024;

/// Reads metadata from the `<description>` block.
pub fn read_metadata(path: &Path) -> AppResult<BookMetadata> {
    let text = read_document(path)?;
    let mut parser = MetadataParser::default();
    stream(&text, |event| parser.on_event(event)).map_err(parse_error)?;

    let mut metadata = parser.metadata;
    metadata.cover = parser
        .cover_id
        .as_deref()
        .and_then(|id| decode_binary(&text, id).ok())
        .map(|bytes| CoverImage { extension: sniff_extension(&bytes), bytes });
    Ok(metadata)
}

/// Extracts one chapter per top-level `<section>` of the main body.
pub fn read_chapters(path: &Path) -> AppResult<Vec<RawChapter>> {
    let text = read_document(path)?;
    let mut parser = BodyParser::default();
    stream(&text, |event| parser.on_event(event)).map_err(parse_error)?;
    parser.finish();

    if parser.chapters.is_empty() {
        return Err(AppError::Parse("FB2 正文里没有可读的章节".into()));
    }
    Ok(parser.chapters)
}

/// Decodes one inlined image by its `<binary id>`.
pub fn read_binary(path: &Path, id: &str) -> AppResult<Vec<u8>> {
    let text = read_document(path)?;
    decode_binary(&text, id)
}

/// Reads the document text, unwrapping the zipped form of the format.
///
/// `.fb2.zip` is the usual distribution form, and a plain `.fb2` can arrive
/// zipped under either name, so the container is sniffed rather than trusted.
fn read_document(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path)?;
    let bytes = if bytes.starts_with(b"PK\x03\x04") { unzip_first(&bytes)? } else { bytes };
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(AppError::Parse("FB2 文档过大".into()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Returns the first plausible entry of a ZIP holding a FictionBook document.
fn unzip_first(bytes: &[u8]) -> AppResult<Vec<u8>> {
    use std::io::Cursor;

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| AppError::Parse(format!("无法打开 FB2 压缩包：{err}")))?;
    let name = archive
        .file_names()
        .find(|name| !name.ends_with('/') && !name.starts_with('.'))
        .map(str::to_string)
        .ok_or_else(|| AppError::Parse("FB2 压缩包是空的".into()))?;
    let mut out = Vec::new();
    archive
        .by_name(&name)
        .map_err(|_| AppError::Parse("无法读取 FB2 压缩包内容".into()))?
        .take(MAX_DOCUMENT_BYTES)
        .read_to_end(&mut out)?;
    Ok(out)
}

/// Runs a streaming pass over the document, feeding every event to `sink`.
fn stream<F>(xml: &str, mut sink: F) -> quick_xml::Result<()>
where
    F: FnMut(Event<'_>),
{
    let mut reader = Reader::from_str(xml);
    // FB2 in the wild declares namespaces it never uses and occasionally leaves
    // a tag unclosed; a lenient reader keeps those books readable.
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buf)?;
        match event {
            Event::Eof => return Ok(()),
            other => sink(other),
        }
        buf.clear();
    }
}

fn parse_error(err: quick_xml::Error) -> AppError {
    AppError::Parse(format!("FB2 解析失败：{err}"))
}

/// Decodes the base64 payload of `<binary id="…">`.
fn decode_binary(xml: &str, id: &str) -> AppResult<Vec<u8>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::new();
    let mut capturing = false;
    let mut payload = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) => {
                if element.name().local_name().as_ref() == "binary"
                    && attribute(&element, "id") == id
                {
                    capturing = true;
                }
            }
            // The base64 payload arrives verbatim; unescaping it would corrupt
            // any `+` that an entity pass decided to rewrite.
            Ok(Event::Text(element)) if capturing => {
                if let Ok(text) = unescape(&element) {
                    payload.push_str(&text);
                }
            }
            Ok(Event::End(element))
                if capturing && element.name().local_name().as_ref() == "binary" =>
            {
                let bytes = STANDARD
                    .decode(payload.trim())
                    .map_err(|err| AppError::Parse(format!("FB2 图片解码失败：{err}")))?;
                if bytes.len() as u64 > MAX_BINARY_BYTES {
                    return Err(AppError::Parse("FB2 图片过大".into()));
                }
                return Ok(bytes);
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(parse_error(err)),
            _ => {}
        }
        buf.clear();
    }

    Err(AppError::Parse(format!("FB2 里没有 id 为 {id} 的图片")))
}

/// Recognises the two container formats FB2 embeds.
fn sniff_extension(bytes: &[u8]) -> String {
    if bytes.starts_with(b"\x89PNG") {
        "png".to_string()
    } else if bytes.starts_with(b"GIF8") {
        "gif".to_string()
    } else if bytes.starts_with(b"RIFF") {
        "webp".to_string()
    } else if bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") {
        "svg".to_string()
    } else {
        "jpeg".to_string()
    }
}

/// Which text run the metadata parser is buffering.
#[derive(Clone, Copy)]
enum MetaField {
    Title,
    Lang,
    Annotation,
    Publisher,
    Isbn,
    AuthorPart,
}

/// Streaming reader for `<description>`.
#[derive(Default)]
struct MetadataParser {
    in_title_info: bool,
    in_coverpage: bool,
    in_author: bool,
    in_binary: bool,
    field: Option<MetaField>,
    text: String,
    author: Vec<String>,
    metadata: BookMetadata,
    cover_id: Option<String>,
}

impl MetadataParser {
    fn on_event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(element) => self.on_start(&element),
            Event::Empty(element) => {
                if element.name().local_name().as_ref() == "image" && self.in_coverpage {
                    self.cover_id = Some(image_id(&element));
                }
            }
            Event::Text(element) => {
                if self.field.is_some()
                    && !self.in_binary
                    && let Ok(text) = unescape(&element)
                {
                    self.text.push_str(&text);
                }
            }
            Event::End(element) => self.on_end(&element),
            _ => {}
        }
    }

    fn on_start(&mut self, element: &quick_xml::events::BytesStart<'_>) {
        let tag = element.name().local_name().as_ref().to_string();
        if tag == "binary" {
            self.in_binary = true;
        }
        if self.in_binary {
            return;
        }
        match tag.as_str() {
            "title-info" => self.in_title_info = true,
            "coverpage" => self.in_coverpage = true,
            "author" if self.in_title_info => {
                self.in_author = true;
                self.author.clear();
            }
            "image" if self.in_coverpage => self.cover_id = Some(image_id(element)),
            "book-title" => self.open(MetaField::Title),
            "lang" => self.open(MetaField::Lang),
            "annotation" => self.open(MetaField::Annotation),
            "publisher" => self.open(MetaField::Publisher),
            "isbn" => self.open(MetaField::Isbn),
            // Author name components, in the order FB2 documents them.
            "first-name" | "middle-name" | "last-name" | "nickname" if self.in_author => {
                self.open(MetaField::AuthorPart)
            }
            _ => {}
        }
    }

    fn on_end(&mut self, element: &quick_xml::events::BytesEnd<'_>) {
        let tag = element.name().local_name().as_ref().to_string();
        if tag == "binary" {
            self.in_binary = false;
            return;
        }
        match tag.as_str() {
            "title-info" => self.in_title_info = false,
            "coverpage" => self.in_coverpage = false,
            "author" if self.in_author => {
                let name = self.author.join(" ").trim().to_string();
                if !name.is_empty() {
                    self.metadata.authors.push(name);
                }
                self.author.clear();
                self.in_author = false;
            }
            _ => {}
        }
        if self.field.is_some() {
            self.flush();
        }
    }

    fn open(&mut self, field: MetaField) {
        self.field = Some(field);
        self.text.clear();
    }

    fn flush(&mut self) {
        let Some(field) = self.field.take() else { return };
        let text = self.text.split_whitespace().collect::<Vec<_>>().join(" ");
        self.text.clear();
        if text.is_empty() {
            return;
        }
        match field {
            MetaField::Title if self.metadata.title.is_empty() => self.metadata.title = text,
            MetaField::Lang if self.metadata.language.is_none() => {
                self.metadata.language = Some(text)
            }
            MetaField::Annotation if self.metadata.description.is_none() => {
                self.metadata.description = Some(text)
            }
            MetaField::Publisher if self.metadata.publisher.is_none() => {
                self.metadata.publisher = Some(text)
            }
            MetaField::Isbn if self.metadata.identifier.is_none() => {
                self.metadata.identifier = Some(text)
            }
            MetaField::AuthorPart => self.author.push(text),
            // A later element of the same kind never overrides an earlier one.
            _ => {}
        }
    }
}

/// The binary id an `<image>` points at, with any `#` fragment dropped.
///
/// `l:href` and `xlink:href` share the local name `href`, so one lookup covers
/// every namespace FB2 uses for image references.
fn image_id(element: &quick_xml::events::BytesStart<'_>) -> String {
    attribute(element, "href").trim_start_matches('#').trim().to_string()
}

/// Elements that end a paragraph in the body.
fn is_block(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "v"
            | "subtitle"
            | "text-author"
            | "date"
            | "cite"
            | "poem"
            | "stanza"
            | "table"
            | "tr"
            | "td"
            | "th"
            | "empty-line"
    )
}

/// Streaming reader for `<body>`: one chapter per top-level `<section>`.
#[derive(Default)]
struct BodyParser {
    in_body: bool,
    in_binary: bool,
    in_title: bool,
    /// Nesting depth of `<section>` inside the body.
    section_depth: usize,
    text: String,
    title: String,
    current: Vec<String>,
    current_title: Option<String>,
    chapters: Vec<RawChapter>,
}

impl BodyParser {
    fn on_event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(element) => {
                let tag = element.name().local_name().as_ref().to_string();
                if tag == "binary" {
                    self.in_binary = true;
                    return;
                }
                if self.in_binary {
                    return;
                }
                self.on_start(&tag, &element);
            }
            Event::Empty(element) => {
                let tag = element.name().local_name().as_ref().to_string();
                if self.in_binary || !self.in_body {
                    return;
                }
                if tag == "image" {
                    self.push_image(&element);
                } else if tag == "empty-line" {
                    self.flush_paragraph();
                }
            }
            Event::Text(element) => {
                if self.in_binary || !self.in_body {
                    return;
                }
                if let Ok(text) = unescape(&element) {
                    if self.in_title {
                        self.title.push_str(&text);
                    } else {
                        self.text.push_str(&text);
                    }
                }
            }
            Event::End(element) => {
                let tag = element.name().local_name().as_ref().to_string();
                if tag == "binary" {
                    self.in_binary = false;
                    return;
                }
                self.on_end(&tag);
            }
            _ => {}
        }
    }

    fn on_start(&mut self, tag: &str, element: &quick_xml::events::BytesStart<'_>) {
        if tag == "body" {
            // `<body name="notes">` carries footnotes, not chapters.
            self.in_body = attribute(element, "name").is_empty();
        } else if !self.in_body {
            // Outside the body (metadata, binaries) nothing is prose.
        } else if tag == "section" {
            if self.section_depth == 0 {
                self.push_chapter();
            }
            self.section_depth += 1;
        } else if tag == "title" && self.section_depth == 1 {
            self.flush_paragraph();
            self.in_title = true;
            self.title.clear();
        } else if tag == "image" {
            self.push_image(element);
        } else if is_block(tag) {
            self.flush_paragraph();
        }
    }

    fn on_end(&mut self, tag: &str) {
        if tag == "body" {
            self.in_body = false;
            return;
        }
        if !self.in_body {
            return;
        }
        if tag == "title" && self.in_title {
            let text = normalise(&self.title);
            self.title.clear();
            self.in_title = false;
            if !text.is_empty() {
                if self.current_title.is_none() {
                    self.current_title = Some(text.clone());
                }
                self.current.push(text);
            }
        } else if tag == "section" {
            self.flush_paragraph();
            self.section_depth = self.section_depth.saturating_sub(1);
        } else if is_block(tag) {
            self.flush_paragraph();
        }
    }

    fn push_image(&mut self, element: &quick_xml::events::BytesStart<'_>) {
        let id = image_id(element);
        if !id.is_empty() {
            self.flush_paragraph();
            self.current.push(format!("{IMAGE_PARAGRAPH_PREFIX}#{id}"));
        }
    }

    fn flush_paragraph(&mut self) {
        let text = normalise(&self.text);
        self.text.clear();
        if !text.is_empty() {
            self.current.push(text);
        }
    }

    fn push_chapter(&mut self) {
        self.flush_paragraph();
        if self.current.is_empty() {
            self.current_title = None;
            return;
        }
        self.chapters.push(RawChapter {
            title: self.current_title.take(),
            paragraphs: std::mem::take(&mut self.current),
        });
    }

    fn finish(&mut self) {
        self.push_chapter();
    }
}

fn normalise(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::fixture;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUg==";

    fn doc(body: &str) -> String {
        format!(
            r##"<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"
             xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>sf</genre>
      <author><first-name>刘</first-name><last-name>慈欣</last-name></author>
      <book-title>三体</book-title>
      <annotation><p>一部科幻小说。</p></annotation>
      <lang>zh</lang>
      <coverpage><image l:href="#cover.png"/></coverpage>
    </title-info>
    <publish-info><publisher>重庆出版社</publisher><isbn>9787536469759</isbn></publish-info>
  </description>
  {body}
  <binary id="cover.png" content-type="image/png">{PNG}</binary>
</FictionBook>"##
        )
    }

    fn write(dir: &Path, name: &str, xml: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, xml.as_bytes()).expect("write fb2");
        path
    }

    #[test]
    fn description_metadata_is_extracted() {
        let dir = fixture::temp_dir("fb2-meta");
        let path = write(&dir, "book.fb2", &doc("<body><section><p>甲</p></section></body>"));

        let metadata = read_metadata(&path).expect("metadata");
        assert_eq!(metadata.title, "三体");
        assert_eq!(metadata.authors, ["刘 慈欣"]);
        assert_eq!(metadata.language.as_deref(), Some("zh"));
        assert_eq!(metadata.publisher.as_deref(), Some("重庆出版社"));
        assert_eq!(metadata.identifier.as_deref(), Some("9787536469759"));
        assert_eq!(metadata.description.as_deref(), Some("一部科幻小说。"));

        let cover = metadata.cover.expect("封面必须来自 binary 块");
        assert_eq!(cover.extension, "png");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sections_become_chapters_with_titles() {
        let dir = fixture::temp_dir("fb2-chapters");
        let body = r#"<body>
          <section><title><p>第一章</p></title><p>正文甲</p><p>正文乙</p></section>
          <section><title><p>第二章</p></title><p>正文丙</p></section>
        </body>
        <body name="notes"><section><p>脚注</p></section></body>"#;
        let path = write(&dir, "book.fb2", &doc(body));

        let chapters = read_chapters(&path).expect("chapters");
        assert_eq!(chapters.len(), 2, "{chapters:?}");
        assert_eq!(chapters[0].title.as_deref(), Some("第一章"));
        assert_eq!(chapters[0].paragraphs, ["第一章", "正文甲", "正文乙"]);
        assert_eq!(chapters[1].title.as_deref(), Some("第二章"));
        assert!(
            !chapters.iter().any(|chapter| chapter.paragraphs.contains(&"脚注".to_string())),
            "notes 正文不应成为章节"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn inline_images_become_marker_paragraphs_and_resolve_to_bytes() {
        let dir = fixture::temp_dir("fb2-image");
        let body =
            r##"<body><section><p>图前</p><p><image l:href="#cover.png"/></p></section></body>"##;
        let path = write(&dir, "book.fb2", &doc(body));

        let chapters = read_chapters(&path).expect("chapters");
        assert_eq!(chapters[0].paragraphs, ["图前", "\u{FFFC}#cover.png"]);

        let bytes = read_binary(&path, "cover.png").expect("binary");
        assert_eq!(bytes.len(), 16, "base64 必须被真正解码");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_zipped_fictionbook_is_unwrapped_by_magic_bytes() {
        let dir = fixture::temp_dir("fb2-zip");
        let path = fixture::write_zip(
            &dir,
            "book.fb2.zip",
            &[("book.fb2", doc("<body><section><p>甲</p></section></body>").as_bytes())],
        );

        let metadata = read_metadata(&path).expect("metadata");
        assert_eq!(metadata.title, "三体");
        assert_eq!(read_chapters(&path).expect("chapters").len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_document_without_sections_is_a_parse_error() {
        let dir = fixture::temp_dir("fb2-empty");
        let path = write(&dir, "book.fb2", &doc("<body></body>"));
        assert!(read_chapters(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_binary_is_reported_not_panicked() {
        let dir = fixture::temp_dir("fb2-nobinary");
        let path = write(&dir, "book.fb2", &doc("<body><section><p>甲</p></section></body>"));
        assert!(read_binary(&path, "nope.png").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn container_sniffing_covers_the_formats_fb2_embeds() {
        assert_eq!(sniff_extension(b"\x89PNG\r\n"), "png");
        assert_eq!(sniff_extension(b"GIF89a"), "gif");
        assert_eq!(sniff_extension(b"RIFF....WEBP"), "webp");
        assert_eq!(sniff_extension(b"\xff\xd8\xff"), "jpeg");
    }
}
