//! Book Pack: one book in a single portable file.
//!
//! `.ctz` is a ZIP holding the untouched source file plus the reading state
//! (progress, favourite, highlights). Chapters and the cover are deliberately
//! *not* stored: the ordinary import pipeline extracts both from the source, so
//! a second copy inside the pack could only drift out of sync.
//!
//! `.ctzx` is the same archive encrypted with AES-256-GCM under a key derived
//! from a password with Argon2id. Every primitive comes from a RustCrypto
//! crate; nothing here invents one.

use std::io::{Cursor, Read, Write};
use std::path::Path;

use aes_gcm::Aes256Gcm;
use aes_gcm::Nonce;
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use argon2::{Algorithm, Argon2, Params, Version};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::annotations;
use super::repository;
use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Extensions the import pipeline hands to this module.
pub const PACK_EXTENSIONS: [&str; 2] = ["ctz", "ctzx"];

/// Name of the manifest inside the archive. A ZIP cannot carry magic bytes, so
/// this file is what identifies an archive as a book pack.
const MANIFEST_ENTRY: &str = "pack.json";
const MANIFEST_FORMAT: &str = "colorreader-book-pack";
const MANIFEST_VERSION: u32 = 1;

/// Entry holding the original file; the extension names the source format.
const SOURCE_PREFIX: &str = "source.";
/// Entry holding progress, favourite flag and highlights.
const READING_ENTRY: &str = "reading.json";

const ENCRYPTED_EXT: &str = "ctzx";
const ENCRYPTED_FORMAT: &str = "colorreader-book-pack-enc";
const ENCRYPTED_VERSION: u32 = 1;

const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;

/// Argon2id work factors: the OWASP floor for interactive logins. Cheap enough
/// to stay well under a second, expensive enough to blunt offline guessing.
const ARGON2_KIB: u32 = 19 * 1024;
const ARGON2_PASSES: u32 = 2;
const ARGON2_LANES: u32 = 1;

/// Reading state that travels with a book.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// 0..1.
    pub progress: f64,
    pub favorite: bool,
    #[serde(default)]
    pub annotations: Vec<PackedAnnotation>,
}

/// A highlight without the ids the database assigns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedAnnotation {
    pub chapter_idx: usize,
    pub start_char: usize,
    pub end_char: usize,
    pub text: String,
}

/// A pack's contents, pulled out of the archive.
#[derive(Debug)]
pub struct Unpacked {
    /// Bytes of the original book file.
    pub source: Vec<u8>,
    /// Extension of the original file, without the dot.
    pub source_ext: String,
    pub reading: Option<Reading>,
}

/// `true` when `path` names a book pack rather than a raw book.
pub fn is_pack(path: &Path) -> bool {
    has_extension(path, &PACK_EXTENSIONS)
}

/// Writes one book to `dest`.
///
/// The format follows the extension: `.ctzx` requires a password and encrypts,
/// anything else writes the plain archive.
pub fn export(
    library: &Library,
    book_id: &str,
    dest: &Path,
    password: Option<&str>,
) -> AppResult<()> {
    let encrypted = has_extension(dest, &[ENCRYPTED_EXT]);
    if encrypted && password.is_none() {
        return Err(AppError::InvalidArgument("加密书档需要设置密码".into()));
    }

    let book = library
        .with(|conn| repository::get(conn, book_id))?
        .ok_or_else(|| AppError::NotFound(book_id.to_string()))?;
    let (source_path, _) = super::book_files(library, book_id)?;
    let source_path = source_path
        .ok_or_else(|| AppError::Message(format!("《{}》的源文件已丢失", book.title)))?;

    let source = std::fs::read(&source_path)?;
    let reading = library.with(|conn| {
        let annotations = annotations::list(conn, book_id)?
            .into_iter()
            .map(|annotation| PackedAnnotation {
                chapter_idx: annotation.chapter_idx,
                start_char: annotation.start_char,
                end_char: annotation.end_char,
                text: annotation.text,
            })
            .collect();
        Ok(Reading { progress: book.progress, favorite: book.favorite, annotations })
    })?;

    let archive = build(&source, book.format.extension(), &reading)?;
    let bytes = match password {
        Some(password) if encrypted => encrypt(&archive, password)?,
        _ => archive,
    };
    std::fs::write(dest, bytes)?;
    Ok(())
}

/// Reads a pack, decrypting it first when the extension says it is encrypted.
pub fn unpack(path: &Path, password: Option<&str>) -> AppResult<Unpacked> {
    let raw = std::fs::read(path)?;
    let archive = if has_extension(path, &[ENCRYPTED_EXT]) {
        let password = password
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::InvalidArgument("导入加密书档需要提供密码".into()))?;
        decrypt(&raw, password)?
    } else {
        raw
    };
    read(&archive)
}

/// Applies a pack's reading state to the book that was just imported.
///
/// Highlights already present are kept rather than duplicated, so re-importing
/// a pack over a shelf that already holds the book is idempotent.
pub fn apply_reading(conn: &Connection, book_id: &str, reading: &Reading) -> AppResult<()> {
    // Skipped at zero: recording progress also stamps `last_read_at`, which
    // would drop an unread book onto the "recently read" shelf.
    if reading.progress > 0.0 {
        repository::set_progress(conn, book_id, reading.progress, None)?;
    }
    repository::set_favorite(conn, book_id, reading.favorite)?;

    for packed in &reading.annotations {
        if !has_highlight(conn, book_id, packed)? {
            annotations::create(
                conn,
                book_id,
                packed.chapter_idx,
                packed.start_char,
                packed.end_char,
                &packed.text,
                None,
            )?;
        }
    }
    Ok(())
}

/// Builds the plain archive in memory. A pack is one book, and the result is
/// written to disk in a single pass either way.
fn build(source: &[u8], source_ext: &str, reading: &Reading) -> AppResult<Vec<u8>> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file(MANIFEST_ENTRY, options)?;
    serde_json::to_writer(
        &mut writer,
        &Manifest { format: MANIFEST_FORMAT.to_string(), version: MANIFEST_VERSION },
    )?;

    writer.start_file(format!("{SOURCE_PREFIX}{source_ext}"), options)?;
    writer.write_all(source)?;

    writer.start_file(READING_ENTRY, options)?;
    serde_json::to_writer(&mut writer, reading)?;

    Ok(writer.finish()?.into_inner())
}

fn read(archive: &[u8]) -> AppResult<Unpacked> {
    let mut zip = ZipArchive::new(Cursor::new(archive))?;
    let names: Vec<String> = zip.file_names().map(str::to_string).collect();

    let manifest: Manifest = serde_json::from_reader(zip.by_name(MANIFEST_ENTRY)?)?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(AppError::UnsupportedFormat(manifest.format));
    }
    if manifest.version > MANIFEST_VERSION {
        return Err(AppError::InvalidArgument(format!(
            "书档版本 {} 高于当前支持的 {MANIFEST_VERSION}",
            manifest.version
        )));
    }

    let source_name = names
        .iter()
        .find(|name| name.starts_with(SOURCE_PREFIX))
        .ok_or_else(|| AppError::Parse("书档缺少源文件".into()))?;
    let source_ext = source_name[SOURCE_PREFIX.len()..].to_string();
    if source_ext.is_empty() {
        return Err(AppError::Parse("书档源文件缺少扩展名".into()));
    }
    let mut source = Vec::new();
    zip.by_name(source_name)?.read_to_end(&mut source)?;

    let reading = match names.iter().any(|name| name == READING_ENTRY) {
        true => Some(serde_json::from_reader(zip.by_name(READING_ENTRY)?)?),
        false => None,
    };

    Ok(Unpacked { source, source_ext, reading })
}

fn has_extension(path: &Path, candidates: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| candidates.iter().any(|candidate| candidate.eq_ignore_ascii_case(ext)))
}

/// Whether this highlight is already on the shelf, so a re-import is a no-op.
fn has_highlight(conn: &Connection, book_id: &str, packed: &PackedAnnotation) -> AppResult<bool> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM annotations
          WHERE book_id = ?1 AND chapter_idx = ?2 AND start_char = ?3 AND end_char = ?4",
        rusqlite::params![
            book_id,
            packed.chapter_idx as i64,
            packed.start_char as i64,
            packed.end_char as i64
        ],
        |row| row.get(0),
    )?;
    Ok(found > 0)
}

/// Contents of `pack.json`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u32,
}

/// Plaintext header of a `.ctzx` file.
///
/// It is fed to GCM as additional data, so editing the KDF parameters or the
/// salt breaks authentication instead of silently weakening the file.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: String,
    version: u32,
    kdf: String,
    /// Argon2id memory cost in KiB.
    m: u32,
    /// Argon2id passes.
    t: u32,
    /// Argon2id lanes.
    p: u32,
    salt: String,
}

impl Header {
    fn new(salt: &[u8]) -> Self {
        Self {
            format: ENCRYPTED_FORMAT.to_string(),
            version: ENCRYPTED_VERSION,
            kdf: "argon2id".to_string(),
            m: ARGON2_KIB,
            t: ARGON2_PASSES,
            p: ARGON2_LANES,
            salt: super::to_hex(salt),
        }
    }

    fn key(&self, password: &str) -> AppResult<[u8; 32]> {
        let salt =
            super::from_hex(&self.salt).ok_or_else(|| AppError::Parse("salt 非法".into()))?;
        let params = Params::new(self.m, self.t, self.p, None)
            .map_err(|err| AppError::Message(format!("密钥派生参数非法：{err}")))?;
        let mut key = [0_u8; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), &salt, &mut key)
            .map_err(|err| AppError::Message(format!("密钥派生失败：{err}")))?;
        Ok(key)
    }
}

/// Encrypts a whole archive under one key, one nonce, one GCM tag.
///
/// The salt is fresh per export, so the key is too: a nonce is never reused
/// with the same key no matter how many packs the user writes.
fn encrypt(archive: &[u8], password: &str) -> AppResult<Vec<u8>> {
    let mut salt = [0_u8; SALT_BYTES];
    let mut nonce = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let header = Header::new(&salt);
    let raw = serde_json::to_vec(&header)?;
    let cipher = Aes256Gcm::new_from_slice(&header.key(password)?)
        .map_err(|_| AppError::Message("密钥长度非法".into()))?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: archive, aad: &raw })
        .map_err(|_| AppError::Message("书档加密失败".into()))?;

    let mut out = Vec::with_capacity(4 + raw.len() + nonce.len() + sealed.len());
    let length = u32::try_from(raw.len()).map_err(|_| AppError::Message("头部过长".into()))?;
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(&raw);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn decrypt(bytes: &[u8], password: &str) -> AppResult<Vec<u8>> {
    let (raw, rest) = split_header(bytes)?;
    let header: Header = serde_json::from_slice(raw)
        .map_err(|_| AppError::InvalidArgument("不是有效的加密书档".into()))?;
    if header.format != ENCRYPTED_FORMAT {
        return Err(AppError::UnsupportedFormat(header.format.to_string()));
    }
    if header.version > ENCRYPTED_VERSION {
        return Err(AppError::InvalidArgument(format!(
            "加密书档版本 {} 高于当前支持的 {ENCRYPTED_VERSION}",
            header.version
        )));
    }
    if rest.len() <= NONCE_BYTES {
        return Err(AppError::Parse("加密书档内容不完整".into()));
    }

    let cipher = Aes256Gcm::new_from_slice(&header.key(password)?)
        .map_err(|_| AppError::Message("密钥长度非法".into()))?;
    // GCM cannot tell a wrong password from a corrupted file, and the message
    // must not tell the user which one it was.
    cipher
        .decrypt(
            Nonce::from_slice(&rest[..NONCE_BYTES]),
            Payload { msg: &rest[NONCE_BYTES..], aad: raw },
        )
        .map_err(|_| AppError::InvalidArgument("密码错误，或书档已损坏".into()))
}

/// Splits `header_len || header || nonce || ciphertext` at the length prefix.
fn split_header(bytes: &[u8]) -> AppResult<(&[u8], &[u8])> {
    let Some(prefix) = bytes.get(..4) else {
        return Err(AppError::Parse("加密书档过短".into()));
    };
    let length = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]);
    let end = 4 + length as usize;
    let header = bytes.get(4..end).ok_or_else(|| AppError::Parse("加密书档头部损坏".into()))?;
    Ok((header, &bytes[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;
    use crate::library::import::ImportOutcome;
    use crate::library::repository::{BookQuery, BookSummary};
    use std::path::PathBuf;

    struct Harness {
        dir: PathBuf,
        layout: Layout,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&dir).expect("open library");
            Self { dir, layout, library }
        }

        fn import(&self, paths: &[PathBuf]) -> Vec<ImportOutcome> {
            super::super::import::import_files(
                &self.library,
                &self.layout,
                paths,
                None,
                &mut |_, _, _| {},
            )
        }

        fn shelf(&self) -> Vec<BookSummary> {
            self.library.with(|conn| repository::list(conn, &BookQuery::default())).expect("list")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// A book on the shelf with progress, a favourite flag and one highlight.
    fn seed_book(harness: &Harness) -> String {
        let epub = fixture::write_epub(
            &harness.dir,
            "source.epub",
            &fixture::full_opf("三体", "刘慈欣"),
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );
        harness.import(&[epub]);
        let id = harness.shelf()[0].id.clone();

        harness
            .library
            .with(|conn| {
                repository::set_progress(conn, &id, 0.25, None)?;
                repository::set_favorite(conn, &id, true)?;
                annotations::create(conn, &id, 0, 1, 3, "你好", None)?;
                Ok(())
            })
            .expect("seed reading state");
        id
    }

    fn export_to(harness: &Harness, id: &str, name: &str, password: Option<&str>) -> PathBuf {
        let dest = harness.dir.join(name);
        export(&harness.library, id, &dest, password).expect("export");
        dest
    }

    fn archive_with(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer.start_file(*name, SimpleFileOptions::default()).expect("start");
            writer.write_all(bytes).expect("write");
        }
        writer.finish().expect("finish").into_inner()
    }

    fn manifest() -> Vec<u8> {
        serde_json::to_vec(&Manifest {
            format: MANIFEST_FORMAT.to_string(),
            version: MANIFEST_VERSION,
        })
        .expect("manifest")
    }

    #[test]
    fn a_plain_pack_round_trips_source_and_reading_state() {
        let harness = Harness::new("pack-plain");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctz", None);

        let unpacked = unpack(&pack, None).expect("unpack");
        assert_eq!(unpacked.source_ext, "epub");
        assert_eq!(unpacked.source, std::fs::read(harness.dir.join("source.epub")).expect("read"));
        let reading = unpacked.reading.expect("reading state must travel");
        assert_eq!(reading.progress, 0.25);
        assert!(reading.favorite);
        assert_eq!(reading.annotations.len(), 1);
        assert_eq!(reading.annotations[0].text, "你好");
    }

    #[test]
    fn a_pack_imports_into_a_second_library_with_its_highlights() {
        let source = Harness::new("pack-source");
        let id = seed_book(&source);
        let pack = export_to(&source, &id, "book.ctz", None);

        let target = Harness::new("pack-target");
        target.import(&[pack]);

        let shelf = target.shelf();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].title, "三体");
        assert_eq!(shelf[0].authors, ["刘慈欣"]);
        assert_eq!(shelf[0].progress, 0.25);
        assert!(shelf[0].favorite);
        let restored =
            target.library.with(|conn| annotations::list(conn, &shelf[0].id)).expect("list");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].text, "你好");
    }

    #[test]
    fn reimporting_the_same_pack_does_not_duplicate_highlights() {
        let harness = Harness::new("pack-idempotent");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctz", None);

        harness.import(&[pack]);
        let shelf = harness.shelf();
        let restored =
            harness.library.with(|conn| annotations::list(conn, &shelf[0].id)).expect("list");
        assert_eq!(restored.len(), 1, "同一条标注不得重复插入");
    }

    #[test]
    fn an_encrypted_pack_is_unreadable_without_the_password() {
        let harness = Harness::new("pack-enc-need-password");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctzx", Some("correct horse"));

        assert!(unpack(&pack, None).is_err());
        let plain = std::fs::read(export_to(&harness, &id, "plain.ctz", None)).expect("read");
        assert_ne!(std::fs::read(&pack).expect("read"), plain, "密文必须与明文不同");
    }

    #[test]
    fn an_encrypted_pack_round_trips_with_its_password() {
        let harness = Harness::new("pack-enc");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctzx", Some("correct horse"));

        let unpacked = unpack(&pack, Some("correct horse")).expect("decrypt");
        assert_eq!(unpacked.reading.expect("reading").progress, 0.25);
        assert!(unpack(&pack, Some("wrong horse")).is_err(), "错误密码必须被 GCM 拒绝");
    }

    #[test]
    fn tampering_with_the_header_breaks_authentication() {
        let harness = Harness::new("pack-tamper");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctzx", Some("pw"));

        let mut bytes = std::fs::read(&pack).expect("read");
        // Flip a bit inside the header: without AAD this would still decrypt.
        bytes[10] ^= 0x01;
        assert!(decrypt(&bytes, "pw").is_err(), "KDF 参数被篡改后必须拒绝解密");
    }

    #[test]
    fn a_pack_without_a_source_entry_is_rejected() {
        let broken = archive_with(&[(MANIFEST_ENTRY, manifest())]);
        assert!(read(&broken).is_err(), "缺少源文件的书档必须被拒绝");
    }

    #[test]
    fn a_foreign_archive_is_rejected_by_its_manifest() {
        let foreign = archive_with(&[(
            MANIFEST_ENTRY,
            serde_json::to_vec(&Manifest { format: "some-other-tool".into(), version: 1 })
                .expect("manifest"),
        )]);
        assert!(matches!(read(&foreign), Err(AppError::UnsupportedFormat(_))));
    }

    #[test]
    fn export_rejects_an_encrypted_destination_without_a_password() {
        let harness = Harness::new("pack-no-password");
        let id = seed_book(&harness);
        assert!(export(&harness.library, &id, &harness.dir.join("x.ctzx"), None).is_err());
    }

    #[test]
    fn pack_extensions_are_recognised_by_extension_alone() {
        assert!(is_pack(Path::new("/a/b.ctz")));
        assert!(is_pack(Path::new("/a/b.CTZX")));
        assert!(!is_pack(Path::new("/a/b.epub")));
    }

    #[test]
    fn hex_round_trips_and_rejects_malformed_input() {
        let bytes = [0_u8, 15, 16, 255];
        assert_eq!(super::super::to_hex(&bytes), "000f10ff");
        assert_eq!(super::super::from_hex("000f10ff"), Some(bytes.to_vec()));
        assert_eq!(super::super::from_hex("0f1"), None);
        assert_eq!(super::super::from_hex("zz"), None);
    }
}
