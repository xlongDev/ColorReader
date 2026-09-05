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
