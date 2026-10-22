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
//! licences are their own. A face arrives the one way left — the reader picks a
//! file they already have. The catalogue's own faces are stylesheets the
//! webview adopts, and never reach this module; the second way in, unpacking a
//! member out of a vendor's archive, was retired together with HarmonyOS Sans.
//!
//! Nothing in this module touches the network: it is the registry.

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
    /// The licence file stored beside the face, when the vendor shipped one.
    ///
    /// 🔴 **Nothing writes this any more, and the field stays anyway.** The only
    /// path that ever set it was the archive install — the vendor's own
    /// agreement travelled with the vendor's own bytes — and that path went with
    /// HarmonyOS Sans. What keeps the field alive is the readers who installed
    /// it before: their `<id>.license.txt` is on disk, `remove` is the only
    /// thing that can take it away, and dropping the field would strand a file
    /// in the fonts directory that nothing will ever clean up. Kept as a name
    /// rather than derived from the id, for the same reason `file` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
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
/// The rule that keeps two entries from sharing a name and the rollback when
/// the row cannot be written are written once, here.
///
/// The refusal happens before anything is created: a rejected import must not
/// leave a fonts directory behind.
fn adopt(
    library: &Library,
    root: &Path,
    name: String,
    extension: &str,
    source: &Path,
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
    std::fs::copy(source, root.join(&file))?;

    let font = announced(Font {
        id,
        name,
        file,
        added_at: crate::library::now_seconds(),
        url: String::new(),
        license: None,
    });
    fonts.push(font.clone());
    if let Err(err) = store(library, &fonts) {
        // A file nobody can select is worse than no file at all.
        let _ = std::fs::remove_file(root.join(&font.file));
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

    adopt(library, root, name, &extension, path)
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

/// Deletes one font: the record first, then the bytes.
///
/// The record goes first on purpose. A font the picker still offers but whose
/// file is gone fails silently in the reader, while a file left behind costs
/// only disk.
///
/// The licence file is swept up too, and that is now the *only* reason the
/// field exists: nothing writes one any more, but the readers who installed
/// HarmonyOS Sans before the archive path was retired still have one on disk.
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
        let dir = std::env::temp_dir().join(format!("fangce-fonts-{name}"));
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

    /// 🔴 A row left behind by the retired archive path still gives its licence
    /// file back.
    ///
    /// Nothing writes `license` any more — the field outlives the path that set
    /// it because readers who installed HarmonyOS Sans still have
    /// `<id>.license.txt` on disk, and `remove` is the only thing that can take
    /// it away. The row is written straight into the settings table here, which
    /// is the only way left to produce one; that is the point of the test.
    #[test]
    fn removing_a_font_takes_a_licence_file_it_did_not_write() {
        let dir = scratch("legacy-licence");
        let library = Library::open(&dir).expect("library");
        let root = dir.join("fonts");
        std::fs::create_dir_all(&root).expect("root");
        let id = "0f0f0f0f-0000-0000-0000-000000000000";
        std::fs::write(root.join(format!("{id}.ttf")), b"\x00\x01\x00\x00 a face").expect("face");
        std::fs::write(root.join(format!("{id}.license.txt")), b"terms").expect("licence");
        store(
            &library,
            &[Font {
                id: id.to_string(),
                name: "HarmonyOS Sans".to_string(),
                file: format!("{id}.ttf"),
                added_at: 0,
                url: String::new(),
                license: Some(format!("{id}.license.txt")),
            }],
        )
        .expect("store");

        remove(&library, &root, id).expect("remove");
        assert!(!root.join(format!("{id}.ttf")).exists(), "字体文件要删掉");
        assert!(!root.join(format!("{id}.license.txt")).exists(), "协议要跟着字体一起删掉");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
