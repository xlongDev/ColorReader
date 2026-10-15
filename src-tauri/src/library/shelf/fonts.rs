//! Fonts the reader imported for the reading surface.
//!
//! The same shape as the dictionary registry: the list is one JSON row in
//! `settings` (`reading.fonts`), so importing a font needs no migration, and
//! the bytes live under `<data dir>/fonts/<id>.<ext>` where nothing else on the
//! machine can address them.
//!
//! The frontend never learns a path. It asks the resource protocol for
//! `/font/<id>` — the private route covers and book files already use — and
//! names the face `cr-<id>`. That name is derivable from the id alone, which is
//! what lets `resolveFont` stay a pure function over the settings key instead
//! of consulting a list.
//!
//! No font data ships with the app: CJK faces are tens of megabytes and their
//! licences are their own. A face therefore arrives one of two ways — the
//! reader picks a file they already have, or the catalogue fetches the vendor's
//! own archive and unpacks one member of it (`font_archive`) — and both land
//! here, as a row in this list.
//!
//! Nothing in this module touches the network or an archive: it is the
//! registry, and the archive path hands it verified bytes.

use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{AppError, AppResult};

/// The settings row holding the whole list.
const KEY: &str = "reading.fonts";

/// What an import accepts. A font is a binary the webview parses, so the list
/// stays short and exact rather than guessing at content.
///
/// `.ttc` counts even though a collection holds several faces: the browser
/// loads the first one, and there is no CSS way to ask for another. Loading the
/// first face beats refusing the file outright, which is the alternative for
/// readers who only have the collection (Source Han Sans ships that way).
const EXTENSIONS: [&str; 5] = ["ttf", "otf", "ttc", "woff", "woff2"];

/// One imported font, as the settings document and the UI hold it.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Font {
    pub id: String,
    /// What the reader sees. Taken from the file's own name: the embedded name
    /// table would mean parsing each format's header, and the file name is what
    /// the reader picked anyway.
    pub name: String,
    /// The stored file's name inside the fonts directory. Carried rather than
    /// derived so resolving an id to a path stays a lookup, never a scan.
    pub file: String,
    pub added_at: i64,
    /// Absolute URL the renderer loads the face from.
    ///
    /// Written for the frontend and deliberately **not** read back: the origin
    /// is decided at compile time (`resource_origin`), and freezing a value
    /// derived from it into storage would outlive the build that produced it.
    #[serde(skip_deserializing, default)]
    pub url: String,
    /// Which catalogue entry installed this, when one did.
    ///
    /// The catalogue's own record of a `file` font is this row and nothing
    /// else: the bytes are here, the face is offered from here, and the
    /// settings row finds its 删除 by looking for this id. `downloadedFonts`
    /// in the settings store is the *webfont* kind's record and stays empty for
    /// a face that arrives as a whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    /// The licence file stored beside the face, when the vendor shipped one.
    ///
    /// Kept as a name rather than derived from the id, for the same reason
    /// `file` is. HarmonyOS Sans's agreement asks that any copy of the fonts
    /// carry its notice and terms, and this is what makes that true of the copy
    /// on the reader's disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

/// Where a face's bytes come from.
///
/// Two shapes rather than one `&[u8]`, because the import path must not read a
/// twenty-megabyte face into memory just to write it out again, while the
/// catalogue path already holds its bytes — they had to be hashed before
/// anything else was allowed to happen to them.
enum Face<'a> {
    Copy(&'a Path),
    Bytes(&'a [u8]),
}

/// Adds the URL, which is derived from the id and therefore never stored with
/// any authority.
fn announced(mut font: Font) -> Font {
    font.url = crate::library::font_url(&font.id);
    font
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}

/// Every imported font, in the order the reader added them.
pub fn list(library: &Library) -> AppResult<Vec<Font>> {
    library.with(|conn| {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |row| row.get(0))
            .optional()?;
        match stored {
            Some(json) => {
                let fonts: Vec<Font> = serde_json::from_str(&json).map_err(|err| {
                    AppError::Message(format!("字体列表已损坏，请重新导入：{err}"))
                })?;
                Ok(fonts.into_iter().map(announced).collect())
            }
            None => Ok(Vec::new()),
        }
    })
}

fn store(library: &Library, fonts: &[Font]) -> AppResult<()> {
    let json = serde_json::to_string(fonts)?;
    library.with(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                               updated_at = excluded.updated_at",
            rusqlite::params![KEY, json, crate::library::now_seconds()],
        )?;
        Ok(())
    })
}

/// The one place a face lands on disk and joins the list.
///
/// Both ways in come through here, so the rule that keeps two entries from
/// sharing a name, the rollback when the row cannot be written, and the licence
/// file that has to travel with the face are each written once.
///
/// The refusal happens before anything is created: a rejected import must not
/// leave a fonts directory behind.
fn adopt(
    library: &Library,
    root: &Path,
    name: String,
    extension: &str,
    face: Face<'_>,
    catalog_id: Option<String>,
    license: Option<&[u8]>,
) -> AppResult<Font> {
    let mut fonts = list(library)?;
    // Two entries with one name would be two identical chips in the picker with
    // no way to tell them apart, so the second import is refused instead.
    if fonts.iter().any(|font| font.name == name) {
        return Err(invalid(format!("「{name}」已经导入过了")));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let file = format!("{id}.{extension}");
    std::fs::create_dir_all(root)?;
    match face {
        Face::Copy(path) => {
            std::fs::copy(path, root.join(&file))?;
        }
        Face::Bytes(bytes) => std::fs::write(root.join(&file), bytes)?,
    }

    let license_file = license.map(|bytes| {
        let stored = format!("{id}.license.txt");
        (stored, bytes)
    });
    if let Some((stored, bytes)) = &license_file {
        std::fs::write(root.join(stored), bytes)?;
    }

    let font = announced(Font {
        id,
        name,
        file,
        added_at: crate::library::now_seconds(),
        url: String::new(),
        catalog_id,
        license: license_file.map(|(stored, _)| stored),
    });
    fonts.push(font.clone());
    if let Err(err) = store(library, &fonts) {
        // A file nobody can select is worse than no file at all.
        let _ = std::fs::remove_file(root.join(&font.file));
        if let Some(license) = &font.license {
            let _ = std::fs::remove_file(root.join(license));
        }
        return Err(err);
    }
    Ok(font)
}

/// Copies one font file in and records it.
pub fn import(library: &Library, root: &Path, path: &Path) -> AppResult<Font> {
    let extension = extension_of(path.to_string_lossy().as_ref())?;

    let name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| invalid("无法从文件名推断字体名"))?
        .to_string();

    adopt(library, root, name, &extension, Face::Copy(path), None, None)
}

/// Records a face the app fetched itself.
///
/// The bytes have already been verified against the catalogue's pin by the
/// caller — this is the half that puts them where the resource protocol can
/// serve them. `catalog_id` is what the settings row looks for to know the
/// entry is installed, and `license` is the vendor's own licence file, written
/// beside the face because the agreements that permit this ask for it.
pub fn install(
    library: &Library,
    root: &Path,
    name: String,
    member: &str,
    catalog_id: String,
    bytes: &[u8],
    license: Option<&[u8]>,
) -> AppResult<Font> {
    let extension = extension_of(member)?;
    adopt(library, root, name, &extension, Face::Bytes(bytes), Some(catalog_id), license)
}

/// The extension a stored face should carry, taken from the name the vendor
/// gave it — and refused unless it is one the webview can actually parse.
fn extension_of(name: &str) -> AppResult<String> {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|ext| EXTENSIONS.contains(&ext.as_str()))
        .ok_or_else(|| invalid("请选择字体文件：.ttf / .otf / .ttc / .woff / .woff2"))
}

/// The font a catalogue entry installed, when one did.
///
/// The catalogue's record of a face that arrives as a whole file *is* this row:
/// the settings page reads it to know whether to offer 下载 or 删除, and the
/// reader path is the list it always was. Nothing else records the entry as
/// installed, which is what keeps such a face out of `downloadedFonts` — that
/// flag means "the sheets are kept for the next launch", and there are no
/// sheets here.
pub fn installed(library: &Library, catalog_id: &str) -> AppResult<Option<Font>> {
    Ok(list(library)?.into_iter().find(|font| font.catalog_id.as_deref() == Some(catalog_id)))
}

/// Deletes one font: the record first, then the bytes.
///
/// The record goes first on purpose. A font the picker still offers but whose
/// file is gone fails silently in the reader, while a file left behind costs
/// only disk.
pub fn remove(library: &Library, root: &Path, id: &str) -> AppResult<()> {
    let mut fonts = list(library)?;
    let Some(index) = fonts.iter().position(|font| font.id == id) else {
        return Err(AppError::NotFound(id.to_string()));
    };
    let removed = fonts.remove(index);
    store(library, &fonts)?;
    let _ = std::fs::remove_file(root.join(&removed.file));
    if let Some(license) = &removed.license {
        let _ = std::fs::remove_file(root.join(license));
    }
    Ok(())
}

/// Where the stored file for `id` lives, or `None` when nothing is recorded
/// under it.
///
/// The resource protocol is the only caller, and it answers every failure the
/// same way, so this reports rather than resolves: an unknown id is a 404, not
/// an error worth a status code of its own.
pub fn path(library: &Library, root: &Path, id: &str) -> AppResult<Option<PathBuf>> {
    let fonts = list(library)?;
    Ok(fonts.iter().find(|font| font.id == id).map(|font| root.join(&font.file)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("colorreader-fonts-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// A stand-in for a font file: the importer copies bytes and never parses
    /// them, and a real face would be megabytes in the repository.
    fn face(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"\x00\x01\x00\x00not really a font").expect("write face");
        path
    }

    #[test]
    fn an_imported_font_is_copied_listed_and_addressable_by_id() {
        let dir = scratch("roundtrip");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");

        let source = face(&dir, "LXGWWenKai-Regular.ttf");
        let font = import(&library, &root, &source).expect("import");

        assert_eq!(font.name, "LXGWWenKai-Regular");
        assert!(font.file.ends_with(".ttf"), "扩展名要跟着走：{}", font.file);
        assert!(
            font.url.ends_with(&format!("/font/{}", font.id)),
            "要给出可加载的 URL：{}",
            font.url
        );

        // The URL is derived, so it has to come back on the next read too: a
        // list that only carried it once would leave the picker with a font it
        // cannot actually load after a restart.
        let listed = list(&library).expect("list");
        assert_eq!(listed, vec![font.clone()]);
        assert_eq!(listed[0].url, font.url);

        let stored = path(&library, &root, &font.id).expect("path").expect("recorded");
        assert!(stored.exists(), "字体文件必须真的落盘");
        assert_eq!(std::fs::read(&stored).expect("read"), std::fs::read(&source).expect("source"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_import_of_the_same_name_is_refused() {
        let dir = scratch("duplicate");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        let source = face(&dir, "SourceHanSans.otf");

        import(&library, &root, &source).expect("first import");
        let err = import(&library, &root, &source).expect_err("第二次导入必须被拒");
        assert!(err.to_string().contains("已经导入过"), "错误要说清原因：{err}");
        assert_eq!(list(&library).expect("list").len(), 1, "拒绝时不能留下第二条记录");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn anything_that_is_not_a_font_is_refused_before_touching_disk() {
        let dir = scratch("extension");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        let source = face(&dir, "notes.txt");

        let err = import(&library, &root, &source).expect_err("非字体必须被拒");
        assert!(err.to_string().contains(".ttf"), "错误要列出可用格式：{err}");
        assert!(!root.exists(), "拒绝发生在落盘之前：目录都不该建出来");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_font_takes_its_bytes_with_it() {
        let dir = scratch("remove");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        let font = import(&library, &root, &face(&dir, "Kaiti.ttf")).expect("import");
        let stored = path(&library, &root, &font.id).expect("path").expect("recorded");

        remove(&library, &root, &font.id).expect("remove");
        assert!(list(&library).expect("list").is_empty());
        assert!(!stored.exists(), "文件也要删掉");
        assert!(path(&library, &root, &font.id).expect("path").is_none());

        let err = remove(&library, &root, &font.id).expect_err("重复删除要报 NotFound");
        assert!(matches!(err, AppError::NotFound(_)), "实际是 {err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_uuids_worth_of_garbage_is_not_a_recorded_font() {
        let dir = scratch("unknown");
        let library = Library::open(&dir).expect("library");
        assert!(path(&library, &dir.join("fonts"), "not-imported").expect("path").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The member's own name carries the format, and the display name does not:
    /// `HarmonyOS Sans` has no extension at all, so deriving one from the label
    /// the picker shows would refuse every catalogue face.
    #[test]
    fn a_catalogue_face_is_recorded_under_its_entry_and_carries_its_licence() {
        let dir = scratch("install");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        let agreement = b"Copyright 2021 Huawei Device Co., Ltd.";

        let font = install(
            &library,
            &root,
            "HarmonyOS Sans".to_string(),
            "HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Regular.ttf",
            "harmonyos-sans".to_string(),
            b"\x00\x01\x00\x00 a face",
            Some(agreement),
        )
        .expect("install");

        assert_eq!(font.name, "HarmonyOS Sans");
        assert!(font.file.ends_with(".ttf"), "扩展名要跟着成员走：{}", font.file);
        assert_eq!(font.catalog_id.as_deref(), Some("harmonyos-sans"));

        // The agreement travels with the copy, which is what clause 2(4) of
        // HarmonyOS Sans's licence asks for.
        let license = font.license.as_deref().expect("许可文件要跟着字体落盘");
        assert_eq!(std::fs::read(root.join(license)).expect("read licence"), agreement);

        assert_eq!(
            installed(&library, "harmonyos-sans").expect("installed").map(|found| found.id),
            Some(font.id.clone()),
            "目录条目要能从列表里找回自己那一行"
        );
        assert!(
            installed(&library, "misans").expect("installed").is_none(),
            "别的条目不能认领这一行"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An imported file belongs to no entry, and the lookup has to say so
    /// rather than matching the first font with no catalogue id.
    #[test]
    fn a_hand_imported_font_belongs_to_no_catalogue_entry() {
        let dir = scratch("not-catalogue");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        let font = import(&library, &root, &face(&dir, "Kaiti.ttf")).expect("import");

        assert!(font.catalog_id.is_none(), "手导入的字体不该带上目录 id");
        assert!(font.license.is_none(), "手导入的字体没有厂商协议可带");
        assert!(installed(&library, "lxgw").expect("installed").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A face whose archive shipped no agreement still installs — and leaves no
    /// empty file behind pretending to be one.
    #[test]
    fn a_face_without_an_agreement_installs_without_inventing_one() {
        let dir = scratch("no-licence");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");

        let font = install(
            &library,
            &root,
            "A Face".to_string(),
            "face.otf",
            "an-entry".to_string(),
            b"\x00\x01\x00\x00 a face",
            None,
        )
        .expect("install");

        assert!(font.license.is_none());
        assert!(!root.join(format!("{}.license.txt", font.id)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 删除 has to take the agreement too: a licence left in the fonts
    /// directory with no face to describe is a file nothing will ever clean up.
    #[test]
    fn removing_a_catalogue_face_takes_its_agreement_with_it() {
        let dir = scratch("remove-licence");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        let font = install(
            &library,
            &root,
            "A Face".to_string(),
            "face.ttf",
            "an-entry".to_string(),
            b"\x00\x01\x00\x00 a face",
            Some(b"terms"),
        )
        .expect("install");
        let license = root.join(font.license.as_deref().expect("licence"));
        assert!(license.exists());

        remove(&library, &root, &font.id).expect("remove");
        assert!(!license.exists(), "协议要跟着字体一起删掉");
        assert!(installed(&library, "an-entry").expect("installed").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
