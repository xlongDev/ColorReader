//! Test-only builders for on-disk book files.
//!
//! Kept in one place so the parser tests and the import pipeline tests agree on
//! what a "valid book" looks like.

use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const CONTAINER: &str = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

/// A unique scratch directory under the system temp folder.
pub fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the epoch")
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("colorreader-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// Bytes that stand in for a cover image. Nothing inspects the content.
pub fn png_bytes() -> Vec<u8> {
    b"\x89PNG\r\n\x1a\ncolorreader-fixture".to_vec()
}

/// Writes a minimal but spec-shaped EPUB and returns its path.
///
/// `extra` entries are stored relative to the archive root; OPF hrefs resolve
/// against `OEBPS/`, so pass paths like `OEBPS/images/cover.png`.
pub fn write_epub(dir: &Path, name: &str, opf: &str, extra: &[(&str, &[u8])]) -> PathBuf {
    let path = dir.join(name);
    let file = std::fs::File::create(&path).expect("create epub fixture");
    let mut writer = ZipWriter::new(file);
    // Stored (uncompressed) needs no compression backend, which keeps the test
    // dependency graph identical to the production one.
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    writer.start_file("mimetype", options).expect("start mimetype");
    writer.write_all(b"application/epub+zip").expect("write mimetype");

    writer.start_file("META-INF/container.xml", options).expect("start container");
    writer.write_all(CONTAINER.as_bytes()).expect("write container");

    writer.start_file("OEBPS/content.opf", options).expect("start opf");
    writer.write_all(opf.as_bytes()).expect("write opf");

    for (entry, bytes) in extra {
        writer.start_file(*entry, options).expect("start extra entry");
        writer.write_all(bytes).expect("write extra entry");
    }

    writer.finish().expect("finish archive").flush().ok();
    path
}

/// Writes a plain ZIP of the given entries, used for CBZ and zipped FB2.
pub fn write_zip(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
    let path = dir.join(name);
    let file = std::fs::File::create(&path).expect("create zip fixture");
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    for (entry, bytes) in entries {
        writer.start_file(*entry, options).expect("start entry");
        writer.write_all(bytes).expect("write entry");
    }

    writer.finish().expect("finish archive").flush().ok();
    path
}

/// Writes a minimal uncompressed PDF: one page per entry of `pages`, plus an
/// Info dictionary when a title is given.
///
/// Hand-built rather than pulled from a crate because the only thing under test
/// is that we can walk the page tree and read the Info dictionary.
pub fn write_pdf(dir: &Path, name: &str, pages: &[&str], title: Option<&str>) -> PathBuf {
    let n = pages.len();
    let font_id = 3 + 2 * n;
    let page_ids: Vec<String> = (0..n).map(|index| format!("{} 0 R", 3 + index * 2)).collect();

    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        format!("<< /Type /Pages /Kids [{}] /Count {} >>", page_ids.join(" "), n).into_bytes(),
    ];
    for page in pages {
        let content_id = objects.len() + 2;
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] \
                 /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        let stream = format!("BT /F1 12 Tf 10 100 Td ({page}) Tj ET\n");
        objects.push(
            format!("<< /Length {} >>\nstream\n{stream}endstream", stream.len()).into_bytes(),
        );
    }
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());

    if let Some(title) = title {
        objects.push(format!("<< /Title ({title}) /Author (fixture) >>").into_bytes());
    }

    let mut out = Vec::new();
    let mut offsets = Vec::with_capacity(objects.len());
    out.extend_from_slice(b"%PDF-1.4\n");
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for offset in &offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    let info =
        if title.is_some() { format!("/Info {} 0 R ", objects.len()) } else { String::new() };
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R {info}>>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );

    let path = dir.join(name);
    std::fs::write(&path, out).expect("write pdf fixture");
    path
}

/// An EPUB whose metadata is complete enough for the library tests.
pub fn full_opf(title: &str, author: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="images/cover.png" media-type="image/png"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>"#
    )
}
