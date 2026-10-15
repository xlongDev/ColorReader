//! Installing a face out of the vendor's own archive.
//!
//! The brand faces — HarmonyOS Sans today — cannot be served from a CDN the way
//! the SIL-OFL ones are. Their agreements permit unmodified copies to travel
//! with software, but forbid redistributing the fonts *on their own*, and a
//! mirror is exactly that. What they do permit is the app fetching the vendor's
//! own archive and unpacking one member of it: the download comes from Huawei,
//! the copy on the reader's disk is Huawei's byte for byte, and the agreement
//! travels with it (`fonts::install` writes it beside the face).
//!
//! The archive is 49.8 MB for one 8 MB face, so it is not downloaded. Its table
//! of contents is read over a range request and only the members the catalogue
//! names are fetched — 5.6 MB of the 49.8 — then stitched into a small archive
//! the ordinary extractor opens (`font_range` does the byte work). No byte
//! offset is pinned anywhere: they come from the archive itself on every
//! install, because a catalogue that froze them would go quietly stale the first
//! time Huawei repacked the package.
//!
//! Downloading the whole archive is still the route that always works, and it is
//! what every narrow-route failure falls back to — an unfamiliar zip shape, a
//! server that ignores `Range`, a member that is not in the directory. That is
//! why the narrow route is allowed to refuse anything it does not fully
//! understand: the cost of being strict is a slower install, never a failed one.
//! Either way the bytes land in a temporary file rather than in memory.
//!
//! 🔴 Nothing here trusts the archive. The member's sha256 is checked before the
//! bytes go anywhere near the fonts directory, and the sizes the archive
//! *declares* for a member are checked before it is fetched or read into memory.

use std::io::{BufReader, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::fonts::{self, Font};
use crate::library::shelf::font_range;

/// The largest a single member of a downloaded archive may claim to be.
///
/// A catalogue face is a CJK font: single digits to tens of megabytes. The cap
/// is not about the face we asked for — that one is hashed — but about the
/// archive, which is not: a substituted or malicious zip could declare a member
/// of tens of gigabytes and have the extractor allocate it before any check
/// could run. 64 MB is comfortably above the largest real face and far below
/// anything that would take the machine down.
const MEMBER_CAP: u64 = 64 * 1024 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Per read, not for the whole transfer: 50 MB on a slow line is minutes of
/// legitimate work, and only a stalled connection is a failure.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// One catalogue entry, as the settings page asks for it to be installed.
///
/// The catalogue itself lives in the frontend (`src/lib/fontCatalog.ts`) — it is
/// data about where fonts come from, and the app's build is where it belongs.
/// This side is handed the parts it needs to do the work, and pins nothing of
/// its own: `sha256` comes across the boundary, and the comparison below is what
/// makes it mean something. A pin the *backend* invented would be no pin at all,
/// because the backend has no idea which bytes are legitimate.
#[derive(specta::Type, Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInstall {
    /// The catalogue entry's id — what marks the font as that entry's, and what
    /// a later 删除 matches on.
    pub catalog_id: String,
    /// What the reader sees in the picker. Taken from the catalogue rather than
    /// from the member's own name: `HarmonyOS_Sans_SC_Regular` is the vendor's
    /// file name, not something anybody wants to pick a font by.
    pub name: String,
    /// The vendor's archive, in order — the first source to answer wins.
    pub sources: Vec<String>,
    /// The member inside it that is the face.
    pub member: String,
    /// sha256 the member's bytes must have, lowercase hex.
    pub sha256: String,
    /// The vendor's licence file inside the same archive, when it ships one.
    pub license_member: Option<String>,
}

/// Downloads the archive, takes the face out of it, verifies it, and hands it
/// to the registry.
pub async fn install(library: Library, root: PathBuf, request: CatalogInstall) -> AppResult<Font> {
    // Before the network: an entry that is already installed is a download
    // nobody asked for. The settings row hides the button in that state, so this
    // is the belt to its braces — a second window, a list that has not
    // refetched, a double click.
    if let Some(font) = fonts::installed(&library, &request.catalog_id)? {
        return Ok(font);
    }

    let scratch = download(&request).await?;

    // Everything past the network is blocking — unzip, hash, write 8 MB — and
    // the temporary file has to outlive all of it, so the guard is moved in and
    // drops when the closure does.
    tokio::task::spawn_blocking(move || unpack(&library, &root, &scratch, &request))
        .await
        .map_err(|err| AppError::Message(format!("安装字体失败：{err}")))?
}

/// The blocking half: open the archive, pull the face out, verify it, and let
/// the registry write it.
fn unpack(
    library: &Library,
    root: &Path,
    archive: &Scratch,
    request: &CatalogInstall,
) -> AppResult<Font> {
    let file = std::fs::File::open(&archive.0)?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file))?;

    let bytes = verified_face(&mut zip, &request.member, &request.sha256)?;

    // The agreement comes out of the same archive, so the copy on the reader's
    // disk is the vendor's own text. Deliberately not pinned: it is a notice
    // shown to a person, not bytes the webview parses, and a pin here would
    // break the whole install the day Huawei corrects a word of it.
    let license = request.license_member.as_deref().and_then(|member| {
        extract_member(&mut zip, member)
            .inspect_err(|err| tracing::warn!(member, error = %err, "字体包里没读到许可文件"))
            .ok()
    });

    fonts::install(
        library,
        root,
        request.name.clone(),
        &request.member,
        request.catalog_id.clone(),
        &bytes,
        license.as_deref(),
    )
}

/// The member's bytes, if they are the ones the catalogue pinned.
fn verified_face<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    member: &str,
    sha256: &str,
) -> AppResult<Vec<u8>> {
    let bytes = extract_member(archive, member)?;
    if sha256_hex(&bytes) != sha256.to_ascii_lowercase() {
        return Err(AppError::Message(format!(
            "字体校验失败：包里的「{member}」与目录里记录的哈希不一致，已放弃安装"
        )));
    }
    Ok(bytes)
}

/// Reads one member out of a zip archive.
///
/// Generic over the reader so a test can hand it bytes it built itself and this
/// module a file it streamed to disk.
fn extract_member<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    member: &str,
) -> AppResult<Vec<u8>> {
    let mut entry = archive
        .by_name(member)
        .map_err(|err| AppError::Message(format!("字体包里没有「{member}」：{err}")))?;
    within_cap(entry.size(), member)?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Whether a size an archive *declares* for a member is one this app will act
/// on.
///
/// Called twice per member, because the two declared sizes bound different
/// things: the compressed one is how many bytes will be fetched, the
/// uncompressed one is how many the extractor will inflate.
///
/// Its own function so the rule is testable without building a 64 MB archive to
/// test it with: the declared size is the whole of what the check reads, and
/// nothing else in this module looks at it.
fn within_cap(declared: u64, member: &str) -> AppResult<()> {
    if declared > MEMBER_CAP {
        return Err(AppError::Message(format!(
            "「{member}」的体积不合理（{declared} 字节），已中止"
        )));
    }
    Ok(())
}

/// sha256 of raw bytes, lowercase hex — the shape the catalogue pins.
fn sha256_hex(bytes: &[u8]) -> String {
    crate::library::to_hex(&Sha256::digest(bytes))
}

/// A downloaded archive on disk, deleted when it goes out of scope.
///
/// The app needs 8 MB of a 50 MB file, so it never lands in memory — but it does
/// land somewhere, and every failure between the download and the install (a
/// truncated transfer, a member that does not hash, a row that will not write)
/// has to leave nothing behind. A guard rather than cleanup at each return:
/// `?` is the whole point of `AppResult`, and the one path that forgets to tidy
/// up is exactly the one nobody tests.
#[derive(Debug)]
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Fetches what the install needs, by the narrowest route that works.
///
/// Two routes, in order:
///
/// 1. **Narrow** — ask for the archive's tail, then its table of contents, then
///    only the members the catalogue names, and stitch them into a small archive
///    the extractor opens as usual. 5.6 MB of a 49.8 MB package.
/// 2. **Wide** — download the whole archive, which is what this did before the
///    narrow route existed.
///
/// The wide route is the answer to *every* narrow-route failure, and that is the
/// point rather than a shortcut: it is what lets the narrow route refuse
/// anything it does not fully understand instead of guessing at it. The two
/// produce the same members — the narrow one hands back the archive's own bytes,
/// re-wrapped — and the tests pin that equivalence.
async fn download(request: &CatalogInstall) -> AppResult<Scratch> {
    let client = client()?;

    let mut narrow_failed: Option<AppError> = None;
    for url in &request.sources {
        match narrow(&client, url, request).await {
            Ok(scratch) => return Ok(scratch),
            Err(err) => {
                tracing::warn!(url, error = %err, "字体包没能只取需要的成员，改下整包");
                narrow_failed = Some(err);
            }
        }
    }

    whole(&client, &request.sources).await.inspect_err(|_| {
        // Both routes failed. The narrow one's reason is the more specific of
        // the two — "the server would not give us a range" says more than "the
        // network is down" — so it is worth having said out loud.
        if let Some(err) = &narrow_failed {
            tracing::warn!(error = %err, "改下整包之后仍然失败");
        }
    })
}

/// The narrow route: the archive's table of contents over range requests, then
/// only the members the catalogue names, stitched into a small archive.
///
/// Everything that can go wrong comes back as an `Err` and is answered by the
/// wide route — a server that ignored the range, a zip shape this module will
/// not guess at, a dropped connection, a member that is not in the directory.
/// None of them is shown to the reader; they are logged. So the only thing worth
/// being careful about here is refusing loudly rather than misreading quietly.
async fn narrow(
    client: &reqwest::Client,
    url: &str,
    request: &CatalogInstall,
) -> AppResult<Scratch> {
    // A suffix range rather than a fixed offset: the archive's size is not known
    // until it answers, and the record wanted is at the end whatever that is.
    let tail = span(client, url, None, font_range::TAIL).await?;
    let layout = font_range::layout(&tail)?;

    let directory = span(client, url, Some(layout.directory_offset), layout.directory_size).await?;

    let mut wanted = vec![request.member.as_str()];
    if let Some(license) = request.license_member.as_deref() {
        wanted.push(license);
    }

    let mut parts = Vec::new();
    for slice in font_range::slices(&directory, &layout, &wanted)? {
        // Both sizes are the archive's own claims, and each bounds a different
        // thing: the compressed one is how much this will fetch, the
        // uncompressed one is what the extractor will inflate.
        within_cap(slice.compressed, &slice.name)?;
        within_cap(slice.uncompressed, &slice.name)?;

        // The header's own name and extra lengths decide where the data starts,
        // so it is read before the member is asked for whole — and the member is
        // then fetched from the header, in one piece, so the chunk that gets
        // stitched is exactly what the archive holds.
        let header = span(client, url, Some(slice.header), font_range::HEADER).await?;
        let (name_len, extra_len) = font_range::local_lengths(&header)?;
        let chunk =
            span(client, url, Some(slice.header), slice.chunk_len(name_len, extra_len)).await?;
        parts.push((slice, chunk));
    }

    // The licence is optional and its absence is not fatal — but the face is the
    // whole errand, and a directory without it means this is not the archive the
    // catalogue describes.
    if !parts.iter().any(|(slice, _)| slice.name == request.member) {
        return Err(AppError::Message(format!("字体包里没有「{}」", request.member)));
    }

    let stitched = font_range::stitch(&parts)?;
    let scratch = Scratch(
        std::env::temp_dir().join(format!("colorreader-font-{}.zip", uuid::Uuid::new_v4())),
    );
    std::fs::write(&scratch.0, &stitched)?;
    Ok(scratch)
}

/// The wide route: the whole archive, streamed to a temporary file.
///
/// Sequential, and the first *success* wins: a 404 from one mirror is a reason
/// to ask the next, not to install whatever it did send.
async fn whole(client: &reqwest::Client, sources: &[String]) -> AppResult<Scratch> {
    let mut last: Option<AppError> = None;
    for url in sources {
        match fetch(client, url).await {
            Ok(scratch) => return Ok(scratch),
            Err(err) => {
                tracing::warn!(url, error = %err, "字体包下载源失败");
                last = Some(err);
            }
        }
    }
    Err(last.unwrap_or_else(|| AppError::Message("字体包没有可用的下载源".to_string())))
}

async fn fetch(client: &reqwest::Client, url: &str) -> AppResult<Scratch> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| AppError::Message(format!("字体包下载失败：{err}")))?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!("字体包下载失败：HTTP {}", response.status())));
    }

    let scratch = Scratch(
        std::env::temp_dir().join(format!("colorreader-font-{}.zip", uuid::Uuid::new_v4())),
    );
    let mut file = std::fs::File::create(&scratch.0)?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| AppError::Message(format!("字体包下载中断：{err}")))?;
        file.write_all(&chunk)?;
    }
    Ok(scratch)
}

/// A client for both routes. One per install rather than one per request: the
/// narrow route makes six, and a fresh connection pool for each would pay the
/// handshake six times.
fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|err| AppError::Message(format!("无法创建 HTTP 客户端：{err}")))
}

/// Asks for `len` bytes from `at`, or the last `len` when `at` is `None`.
///
/// Fails rather than returning the wrong bytes if the response is shorter than
/// what was asked for: a range request that comes back truncated is a broken
/// answer, and stitching a member out of half its bytes would produce an archive
/// whose only symptom is a hash that does not match.
async fn span(
    client: &reqwest::Client,
    url: &str,
    at: Option<u64>,
    len: u64,
) -> AppResult<Vec<u8>> {
    let range = match at {
        Some(at) => format!("bytes={at}-{}", at + len.max(1) - 1),
        None => format!("bytes=-{len}"),
    };

    let response = client
        .get(url)
        .header(reqwest::header::RANGE, range)
        .send()
        .await
        .map_err(|err| AppError::Message(format!("字体包下载失败：{err}")))?;

    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let bytes = response
            .bytes()
            .await
            .map_err(|err| AppError::Message(format!("字体包下载中断：{err}")))?;
        // A slice that stops short is a broken answer — but only when both ends
        // were named. A suffix range on an archive smaller than the window
        // legitimately returns the whole file.
        if at.is_some() && (bytes.len() as u64) < len {
            return Err(AppError::Message(format!(
                "服务器只回了 {} 字节，要的是 {len} 字节",
                bytes.len()
            )));
        }
        return Ok(bytes.to_vec());
    }

    if response.status().is_success() {
        // A 200 where a 206 was asked for: the server ignored the `Range`
        // header and is about to send the whole archive. That body is exactly
        // what the wide route would fetch, but it is not the slice this route
        // needs — and reading 50 MB just to discover that is worse than asking
        // again the way that always works. Dropping the response closes it.
        return Err(AppError::Message("服务器忽略了 Range 请求".to_string()));
    }

    Err(AppError::Message(format!("字体包下载失败：HTTP {}", response.status())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead as _, Cursor};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// An archive built in memory. The extractor is generic over its reader, so
    /// this is the same code path a 50 MB download takes.
    fn archive_bytes(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in members {
            writer
                .start_file(name.to_string(), zip::write::SimpleFileOptions::default())
                .expect("start member");
            writer.write_all(bytes).expect("write member");
        }
        writer.finish().expect("finish archive").into_inner()
    }

    fn archive(members: &[(&str, &[u8])]) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        zip::ZipArchive::new(Cursor::new(archive_bytes(members))).expect("read archive")
    }

    #[test]
    fn a_member_comes_back_byte_for_byte() {
        let mut zip = archive(&[
            ("HarmonyOS Sans/LICENSE.txt", b"terms"),
            ("HarmonyOS Sans/SC/Regular.ttf", b"\x00\x01\x00\x00 a face"),
        ]);
        let bytes = extract_member(&mut zip, "HarmonyOS Sans/SC/Regular.ttf").expect("extract");
        assert_eq!(bytes, b"\x00\x01\x00\x00 a face");
    }

    #[test]
    fn a_member_the_archive_does_not_have_is_named_in_the_error() {
        let mut zip = archive(&[("a.ttf", b"a face")]);
        let err = extract_member(&mut zip, "missing.ttf").expect_err("must be refused");
        assert!(err.to_string().contains("missing.ttf"), "错误要点名成员：{err}");
    }

    /// The declared size is checked before the allocation, which is the whole
    /// reason the cap is not simply `bytes.len()` after the fact.
    #[test]
    fn an_absurd_declared_size_is_refused_at_the_cap() {
        assert!(within_cap(MEMBER_CAP, "face.ttf").is_ok(), "正好等于上限要放行");
        assert!(within_cap(MEMBER_CAP + 1, "face.ttf").is_err(), "越过上限一个字节也要拒");
        let err = within_cap(64 * 1024 * 1024 * 1024, "huge.ttf").expect_err("must be refused");
        assert!(err.to_string().contains("huge.ttf"), "{err}");
    }

    /// The archive's bytes with its one member's *declared* size rewritten.
    ///
    /// The cap is about what an archive claims, not about what it holds, so the
    /// only way to reach it is to lie in the header — and a 64 MB member cannot
    /// be built to test with. Both headers are patched so they agree: a reader
    /// that cross-checks them would otherwise refuse the archive for a different
    /// reason, and the test below would go green without the cap being consulted
    /// at all.
    fn with_declared_size(bytes: Vec<u8>, declared: u32) -> Vec<u8> {
        let mut bytes = bytes;
        // Local file header: 30 fixed bytes in, the uncompressed size at +22.
        bytes[22..26].copy_from_slice(&declared.to_le_bytes());
        // Central directory: 46 fixed bytes in, the same field at +24.
        let cd =
            bytes.windows(4).position(|window| window == b"PK\x01\x02").expect("central directory");
        bytes[cd + 24..cd + 28].copy_from_slice(&declared.to_le_bytes());
        bytes
    }

    /// `within_cap` on its own proves the rule; this proves `extract_member`
    /// asks it. Without the call the entry is read anyway — the allocation is
    /// 64 MB rather than a terabyte precisely so that the failure is a wrong
    /// answer here instead of a dead test process.
    #[test]
    fn the_extractor_asks_the_cap_before_it_reads_anything() {
        let mut zip = zip::ZipArchive::new(Cursor::new(with_declared_size(
            archive_bytes(&[("face.ttf", b"a face")]),
            MEMBER_CAP as u32 + 1,
        )))
        .expect("read archive");
        let err = extract_member(&mut zip, "face.ttf").expect_err("超限的声明必须在读取前被拒");
        assert!(err.to_string().contains("体积不合理"), "{err}");
    }

    /// A declared size inside the cap still reads normally — the guard must not
    /// be refusing everything it sees.
    #[test]
    fn a_declared_size_inside_the_cap_is_not_in_the_way() {
        let mut zip = zip::ZipArchive::new(Cursor::new(with_declared_size(
            archive_bytes(&[("face.ttf", b"a face")]),
            6,
        )))
        .expect("read archive");
        assert_eq!(extract_member(&mut zip, "face.ttf").expect("extract"), b"a face");
    }

    /// A member that *lies* about being small is stopped by the archive reader,
    /// not by this module.
    ///
    /// `within_cap` reads the size the archive declares, so a bomb only has to
    /// declare a small one to get past it — this module alone would then read
    /// until the disk filled. It does not, because `zip` bounds every read by
    /// that same declared size and fails one byte past it, which is why the two
    /// checks together leave no way to buffer more than `MEMBER_CAP`.
    ///
    /// This is an assumption about a dependency rather than about code here, so
    /// it is worth a test: a future `zip` that stopped applying the bound would
    /// not break any of the others, and the hole would only show up as a
    /// machine that ran out of memory downloading a font.
    #[test]
    fn a_member_that_lies_about_being_small_is_stopped_by_the_archive() {
        let mut zip = zip::ZipArchive::new(Cursor::new(with_declared_size(
            archive_bytes(&[("face.ttf", b"a face")]),
            3,
        )))
        .expect("read archive");
        let err = extract_member(&mut zip, "face.ttf").expect_err("声明小于实际必须报错");
        assert!(err.to_string().contains("declared uncompressed size"), "{err}");
    }

    #[test]
    fn the_hash_is_the_one_the_catalogue_pins() {
        // A known vector: a wrong digest length or a non-hex encoding would
        // otherwise show up as a catalogue entry that never verifies.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_member_that_does_not_hash_to_the_pin_never_reaches_the_caller() {
        let mut zip = archive(&[("face.ttf", b"the real face")]);
        let pin = sha256_hex(b"the real face");
        assert_eq!(verified_face(&mut zip, "face.ttf", &pin).expect("verified"), b"the real face");

        // Upper case is accepted: the pin's case is the catalogue's business,
        // and refusing it here would be a spelling test.
        assert!(verified_face(&mut zip, "face.ttf", &pin.to_uppercase()).is_ok());

        let err = verified_face(&mut zip, "face.ttf", &sha256_hex(b"somebody else's face"))
            .expect_err("哈希不符必须拒绝");
        assert!(err.to_string().contains("校验失败"), "{err}");
    }

    /// The blocking half, end to end: a real archive on disk, the face pulled
    /// out of it and verified, the agreement beside it, and the row written.
    ///
    /// `Scratch` is built directly rather than by downloading, which is the only
    /// way to reach `unpack` without a network — and the type is what makes that
    /// safe to do, since the temporary file still gets cleaned up.
    #[test]
    fn the_face_and_the_agreement_come_out_of_the_same_archive() {
        let dir = std::env::temp_dir().join("colorreader-font-archive-unpack");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");

        let face = b"\x00\x01\x00\x00 a face";
        let terms = b"Copyright 2021 Huawei Device Co., Ltd.";
        let path = dir.join("HarmonyOS-Sans.zip");
        std::fs::write(
            &path,
            archive_bytes(&[
                ("HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Regular.ttf", face),
                ("HarmonyOS Sans/HarmonyOS_Sans_SC/LICENSE.txt", terms),
            ]),
        )
        .expect("write archive");

        let font = unpack(
            &library,
            &root,
            &Scratch(path.clone()),
            &CatalogInstall {
                catalog_id: "harmonyos-sans".to_string(),
                name: "HarmonyOS Sans".to_string(),
                sources: Vec::new(),
                member: "HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Regular.ttf"
                    .to_string(),
                sha256: sha256_hex(face),
                license_member: Some("HarmonyOS Sans/HarmonyOS_Sans_SC/LICENSE.txt".to_string()),
            },
        )
        .expect("unpack");

        assert_eq!(std::fs::read(root.join(&font.file)).expect("read face"), face);
        let license = root.join(font.license.as_deref().expect("协议要跟着字体落盘"));
        assert_eq!(std::fs::read(license).expect("read licence"), terms);
        assert_eq!(fonts::installed(&library, "harmonyos-sans").expect("installed"), Some(font));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_face_that_is_already_installed_is_not_downloaded_again() {
        let dir = std::env::temp_dir().join("colorreader-font-archive-already");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        fonts::install(
            &library,
            &root,
            "HarmonyOS Sans".to_string(),
            "face.ttf",
            "harmonyos-sans".to_string(),
            b"\x00\x01\x00\x00 a face",
            None,
        )
        .expect("install");

        // No sources at all: a download attempt would fail with "没有可用的
        // 下载源", so answering with the existing row is the only way through.
        let request = CatalogInstall {
            catalog_id: "harmonyos-sans".to_string(),
            name: "HarmonyOS Sans".to_string(),
            sources: Vec::new(),
            member: "face.ttf".to_string(),
            sha256: sha256_hex(b"\x00\x01\x00\x00 a face"),
            license_member: None,
        };
        let found = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(install(library, root, request))
            .expect("already installed");
        assert_eq!(found.name, "HarmonyOS Sans");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_temporary_file_is_gone_once_the_guard_drops() {
        let path =
            std::env::temp_dir().join(format!("colorreader-scratch-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"50 MB of somebody's archive").expect("write");
        {
            let _scratch = Scratch(path.clone());
        }
        assert!(!path.exists(), "临时文件必须自己删掉");
    }

    const FACE: &str = "HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Regular.ttf";
    const TERMS: &str = "HarmonyOS Sans/HarmonyOS_Sans_SC/LICENSE.txt";
    const FACE_BYTES: &[u8] = b"\x00\x01\x00\x00 the regular face";
    const TERMS_BYTES: &[u8] = b"Copyright 2021 Huawei Device Co., Ltd.";

    /// A one-file HTTP server that speaks `Range`, on its own thread.
    ///
    /// The narrow route is the primary path now, and without a server the only
    /// thing that can be tested is what `font_range` does with bytes it already
    /// has. This covers the part in between: that the right ranges are asked
    /// for, that the answers are stitched into something the extractor accepts,
    /// that the fallbacks fire, and — the point of the whole change — that the
    /// narrow route moves less than the archive does.
    struct Server {
        url: String,
        served: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
    }

    impl Server {
        /// `ignores_range` answers every request with the whole file and a 200,
        /// which is what a server without range support does.
        fn start(archive: Vec<u8>, ignores_range: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let port = listener.local_addr().expect("address").port();
            listener.set_nonblocking(true).expect("non-blocking");

            let archive = Arc::new(archive);
            let served = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));

            let thread = {
                let (archive, served, stop) = (archive.clone(), served.clone(), stop.clone());
                std::thread::spawn(move || {
                    while !stop.load(Ordering::SeqCst) {
                        match listener.accept() {
                            Ok((stream, _)) => {
                                let (archive, served) = (archive.clone(), served.clone());
                                std::thread::spawn(move || {
                                    let _ = respond(stream, &archive, ignores_range, &served);
                                });
                            }
                            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(std::time::Duration::from_millis(2));
                            }
                            Err(_) => break,
                        }
                    }
                })
            };
            drop(thread);

            Self { url: format!("http://127.0.0.1:{port}/archive.zip"), served, stop }
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }

    fn respond(
        mut stream: TcpStream,
        archive: &[u8],
        ignores_range: bool,
        served: &AtomicUsize,
    ) -> std::io::Result<()> {
        let mut reader = std::io::BufReader::new(stream.try_clone()?);
        let mut range: Option<String> = None;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 {
                return Ok(());
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                break;
            }
            // Header names are case-insensitive, and hyper lowercases them.
            if let Some(value) = trimmed.to_ascii_lowercase().strip_prefix("range: ") {
                range = Some(value.to_string());
            }
        }

        let total = archive.len() as u64;
        let span = match (range, ignores_range) {
            (Some(spec), false) => parse_range(&spec, total),
            _ => None,
        };

        let (status, extra, body) = match span {
            Some((from, to)) => (
                "206 Partial Content",
                format!("Content-Range: bytes {from}-{to}/{total}\r\n"),
                &archive[from as usize..=to as usize],
            ),
            None => ("200 OK", String::new(), archive),
        };
        served.fetch_add(body.len(), Ordering::SeqCst);

        write!(
            stream,
            "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(body)?;
        stream.flush()
    }

    /// `bytes=a-b` and `bytes=-n` — the two forms the app sends.
    fn parse_range(spec: &str, total: u64) -> Option<(u64, u64)> {
        let (from, to) = spec.strip_prefix("bytes=")?.split_once('-')?;
        if from.is_empty() {
            let last: u64 = to.parse().ok()?;
            return Some((total.saturating_sub(last), total - 1));
        }
        let from: u64 = from.parse().ok()?;
        let to: u64 = if to.is_empty() { total - 1 } else { to.parse().ok()? };
        Some((from, to.min(total - 1)))
    }

    /// An archive comfortably larger than the tail window, holding a member
    /// nobody wants.
    ///
    /// The size is load-bearing: below the 64 KB tail window a suffix range
    /// returns the whole file, and "the narrow route moves less" would be
    /// untestable. The unwanted member is what the narrow route has to leave
    /// behind, and it is incompressible on purpose — filler that deflates to
    /// nothing would take the archive back under the window.
    fn served_fixture() -> Vec<u8> {
        let mut filler = Vec::with_capacity(300 * 1024);
        let mut seed = 0x1234_5678u32;
        for _ in 0..300 * 1024 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            filler.push((seed >> 16) as u8);
        }
        archive_bytes(&[
            (FACE, FACE_BYTES),
            (TERMS, TERMS_BYTES),
            ("HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Bold.ttf", &filler),
        ])
    }

    fn served_request(url: &str) -> CatalogInstall {
        CatalogInstall {
            catalog_id: "harmonyos-sans".to_string(),
            name: "HarmonyOS Sans".to_string(),
            sources: vec![url.to_string()],
            member: FACE.to_string(),
            sha256: sha256_hex(FACE_BYTES),
            license_member: Some(TERMS.to_string()),
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Runtime::new().expect("runtime").block_on(future)
    }

    fn narrow_from(server: &Server, request: &CatalogInstall) -> AppResult<Scratch> {
        block_on(narrow(&client().expect("client"), &server.url, request))
    }

    /// The narrow route moves the members, not the archive — which is the entire
    /// reason it exists, so it is worth a number rather than a comment.
    #[test]
    fn the_narrow_route_asks_for_less_than_the_archive_holds() {
        let archive = served_fixture();
        let server = Server::start(archive.clone(), false);
        let scratch = narrow_from(&server, &served_request(&server.url)).expect("窄路");

        let moved = server.served.load(Ordering::SeqCst);
        let stitched = std::fs::metadata(&scratch.0).expect("stitched").len() as usize;
        assert!(moved < archive.len(), "窄路必须比整包少：{moved} 对 {}", archive.len());
        assert!(stitched < archive.len(), "拼出来的档案必须比整包小：{stitched}");
    }

    /// What the narrow route produces is what the wide route would have: the
    /// face, and the agreement beside it.
    #[test]
    fn the_narrow_route_installs_the_face_and_the_agreement() {
        let server = Server::start(served_fixture(), false);
        let request = served_request(&server.url);
        let scratch = narrow_from(&server, &request).expect("窄路");

        let dir = std::env::temp_dir().join("colorreader-font-archive-narrow");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");

        let font = unpack(&library, &root, &scratch, &request).expect("unpack");
        assert_eq!(std::fs::read(root.join(&font.file)).expect("read face"), FACE_BYTES);
        let license = root.join(font.license.as_deref().expect("协议要跟着字体落盘"));
        assert_eq!(std::fs::read(license).expect("read licence"), TERMS_BYTES);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fallback that makes the narrow route safe to be strict. A server that
    /// ignores `Range` is not an error the reader sees — it is a bigger download.
    #[test]
    fn a_server_that_ignores_the_range_is_fallen_back_from() {
        let archive = served_fixture();
        let server = Server::start(archive.clone(), true);
        let scratch = block_on(download(&served_request(&server.url))).expect("应当回退到整包");
        assert_eq!(
            std::fs::metadata(&scratch.0).expect("size").len() as usize,
            archive.len(),
            "回退拿到的是整包本身"
        );
    }

    /// Same fallback, the other reason for it: the archive is not the one the
    /// catalogue describes, so the member is simply not in it.
    #[test]
    fn a_member_the_archive_does_not_have_is_fallen_back_from() {
        let archive = served_fixture();
        let server = Server::start(archive.clone(), false);
        let mut request = served_request(&server.url);
        request.member = "HarmonyOS Sans/HarmonyOS_Sans_SC/Nope.ttf".to_string();

        let scratch = block_on(download(&request)).expect("应当回退到整包");
        assert_eq!(std::fs::metadata(&scratch.0).expect("size").len() as usize, archive.len());
    }

    /// A server that ignores `Range` has to be *detected*, not accommodated. The
    /// whole body is not the slice that was asked for, and treating it as one
    /// would put the wrong bytes in the stitched archive — which is exactly the
    /// failure the hash would catch, but only after 50 MB had been moved.
    #[test]
    fn a_200_where_a_206_was_asked_for_is_refused_rather_than_used_as_a_slice() {
        let server = Server::start(served_fixture(), true);
        let err = block_on(span(&client().expect("client"), &server.url, Some(0), 30))
            .expect_err("忽略 Range 的响应不能当成切片");
        assert!(err.to_string().contains("Range"), "{err}");
    }

    /// The cap reads the size the directory *declares*, and it has to be read
    /// before the request goes out — otherwise a directory claiming a huge
    /// member would be fetched before anything could object.
    #[test]
    fn a_member_that_claims_an_absurd_compressed_size_is_refused_before_the_fetch() {
        let mut archive = served_fixture();
        with_declared(&mut archive, COMPRESSED, u32::try_from(MEMBER_CAP + 1).expect("fits"));
        let server = Server::start(archive, false);
        let request = served_request(&server.url);

        let err = narrow_from(&server, &request).expect_err("超限的声明必须在发请求前被拒");
        assert!(err.to_string().contains("体积不合理"), "{err}");

        // And the install as a whole still lands, by the wide route.
        assert!(block_on(download(&request)).is_ok(), "回退到整包应当成功");
    }

    /// The other declared size, and the other reason it is capped: a member that
    /// claims to inflate to something enormous is not something to hand the
    /// extractor at all.
    #[test]
    fn a_member_that_claims_an_absurd_uncompressed_size_is_refused() {
        let mut archive = served_fixture();
        with_declared(&mut archive, UNCOMPRESSED, u32::try_from(MEMBER_CAP + 1).expect("fits"));
        let server = Server::start(archive, false);

        let err = narrow_from(&server, &served_request(&server.url)).expect_err("超限要拒");
        assert!(err.to_string().contains("体积不合理"), "{err}");
    }

    /// A declared size that runs past the end of the archive. The server cannot
    /// send bytes that are not there, and a slice that stops short is a broken
    /// answer — stitching half a member would produce an archive whose only
    /// symptom is a hash that does not match.
    #[test]
    fn a_member_that_claims_more_than_the_archive_holds_is_fallen_back_from() {
        let mut archive = served_fixture();
        let over = u32::try_from(archive.len() + 100 * 1024).expect("fits");
        with_declared(&mut archive, COMPRESSED, over);
        let server = Server::start(archive, false);
        let request = served_request(&server.url);

        let err = narrow_from(&server, &request).expect_err("短了一截的切片不能用");
        assert!(err.to_string().contains("服务器只回了"), "{err}");
        assert!(block_on(download(&request)).is_ok(), "回退到整包应当成功");
    }

    /// Field offsets inside a central directory entry — where the lies below are
    /// written. Not re-exported from `font_range`, which keeps its own.
    const COMPRESSED: usize = 20;
    const UNCOMPRESSED: usize = 24;

    /// Rewrites the first directory entry's compressed or uncompressed size —
    /// the lies the caps exist to catch, and ones that cannot be told any other
    /// way, since a 64 MB member cannot be built to test with.
    fn with_declared(archive: &mut [u8], field: usize, declared: u32) {
        let tail = &archive[archive.len() - font_range::TAIL as usize..];
        let layout = font_range::layout(tail).expect("layout");
        let at = layout.directory_offset as usize + field;
        archive[at..at + 4].copy_from_slice(&declared.to_le_bytes());
    }

    /// The narrow route against the real archive.
    ///
    /// Everything else here runs on an archive this repo built, and Huawei's is
    /// not one of those: it sets the data-descriptor flag, parks the real sizes
    /// in its central directory, carries extra fields this module never parses,
    /// and is 49.8 MB. None of that can be faked convincingly, so this asks the
    /// vendor — and because it needs the network it is off unless asked for:
    ///
    /// ```text
    /// cargo test --lib the_real_archive -- --ignored --nocapture
    /// ```
    ///
    /// It ends by handing the stitched archive to the *ordinary* extractor, so
    /// what it proves is the thing that matters: the narrow route's output is
    /// something the wide route's reader accepts, holding the pinned face.
    #[test]
    #[ignore = "需要网络：对着华为的真实整包验证按 Range 取成员"]
    fn the_real_archive_gives_up_the_pinned_face_through_the_narrow_route() {
        let request = CatalogInstall {
            catalog_id: "harmonyos-sans".to_string(),
            name: "HarmonyOS Sans".to_string(),
            sources: vec![
                "https://developer.huawei.com/images/download/general/HarmonyOS-Sans.zip"
                    .to_string(),
            ],
            member: "HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Regular.ttf".to_string(),
            sha256: "297b088424be212207df2ce8b98e335468b782aa6b96832af0b8b773d711e2b1".to_string(),
            license_member: Some("HarmonyOS Sans/HarmonyOS_Sans_SC/LICENSE.txt".to_string()),
        };

        let scratch = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(narrow(&client().expect("client"), &request.sources[0], &request))
            .expect("窄路应当成功");

        let stitched = std::fs::metadata(&scratch.0).expect("stitched").len();
        assert!(stitched < 8 * 1024 * 1024, "拼出来的档案应当远小于整包：{stitched} 字节");

        let file = std::fs::File::open(&scratch.0).expect("open");
        let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).expect("open archive");

        let face = verified_face(&mut zip, &request.member, &request.sha256)
            .expect("拼出来的档案里应当有那条被钉住的字体");
        assert_eq!(face.len(), 8_261_128);

        let terms = extract_member(&mut zip, request.license_member.as_deref().expect("licence"))
            .expect("协议应当也在里面");
        assert!(terms.windows(4).any(|w| w == b"Copy"), "协议文本应当可读");

        println!("窄路：整包 52,165,952 字节 → 拼出 {stitched} 字节，字体 {} 字节", face.len());
    }
}
