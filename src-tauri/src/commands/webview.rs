//! `webview.*` 命令：把 webview 的一块区域拍成 PNG。
//!
//! readest 桌面端不做 CSS 翻页动画，而是**把旧页拍成一张位图，再用它演** —— 它的
//! foliate 补丁只负责 web 那条路。理由是 CSS 拿不到快照的像素，只能拿到两个整页
//! 图层，于是「仿真」只能做成绕 Y 轴翻牌，做不出绕圆柱包裹、背面透出纸色的真卷曲。
//!
//! 我们只把这条路用在「仿真」上：「覆盖」的越界问题归因于分层 View Transition
//! 画在视图过渡顶层（祖先的 `overflow: hidden` 裁不住它），那件事已经在
//! `globals.css` 里用 `::view-transition-group(foliate-turn)` 裁掉，不必为它多
//! 付一次截屏。
//!
//! 所以这一层只回答一个问题：**让我拿像素**。其余（画法、时序、手势）在
//! `src/features/reader/pageCurl.ts` 与 `capturedTurn.ts`。
//!
//! 平台：目前只有 macOS（`WKWebView.takeSnapshotWithConfiguration:`）。别的平台
//! 返回错误，前端据此回退到 CSS 那条路 —— 宁可少一种动画，也不能没有翻页。

use crate::error::{AppError, AppResult};

/// 要抓的区域，**视口坐标**（CSS px，origin 左上）。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `webview.capture_region` —— 阅读区那一片的 PNG 字节。
///
/// 走二进制通道（`tauri::ipc::Response`）而不是 JSON：一张视网膜尺寸的 PNG
/// 是几 MB，序列化成数字数组过一次 IPC 是几十毫秒且会卡住主线程。也正因为
/// Specta 描述不了这个返回类型，它不进 `collect_commands!`，由 `src/lib/ipc.ts`
/// 手写（与 `book_asset` / `book_source_file` 同一条通道）。
#[tauri::command]
pub async fn webview_capture_region(
    window: tauri::WebviewWindow,
    region: CaptureRegion,
) -> AppResult<tauri::ipc::Response> {
    if !region.is_sane() {
        return Err(AppError::InvalidArgument(format!(
            "截屏区域不合法：{}x{} @ ({}, {})",
            region.width, region.height, region.x, region.y
        )));
    }
    let png = platform::capture(&window, region).map_err(AppError::Message)?;
    Ok(tauri::ipc::Response::new(png))
}

impl CaptureRegion {
    /// 有限、非负、有面积。WebKit 拿到 NaN 会把整个快照变成 0x0。
    fn is_sane(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|value| value.is_finite())
            && self.width >= 1.0
            && self.height >= 1.0
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    use super::CaptureRegion;

    /// WebKit 正常一两帧就回来。超时就当这条路走不通：前端回退到 CSS 动画，
    /// 不能让一次翻页卡在等截屏上。
    const TIMEOUT: Duration = Duration::from_millis(500);

    pub fn capture(
        window: &tauri::WebviewWindow,
        region: CaptureRegion,
    ) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        // `with_webview` 把闭包送到主线程执行（AppKit 只认主线程），
        // 完成回调再通过 channel 把 PNG 送回来。
        window
            .with_webview(move |webview| {
                // SAFETY: 主线程；`inner()` 是 wry 的 WKWebView 句柄。
                unsafe { start_snapshot(webview.inner().cast::<WKWebView>(), region, tx) };
            })
            .map_err(|err| format!("拿不到 webview 句柄：{err}"))?;

        match rx.recv_timeout(TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err("截屏超时".into()),
            Err(RecvTimeoutError::Disconnected) => Err("截屏回调没有回来".into()),
        }
    }

    /// SAFETY: 必须跑在主线程，且 `view` 必须是一个活的 WKWebView。
    unsafe fn start_snapshot(
        view: *mut WKWebView,
        region: CaptureRegion,
        tx: mpsc::Sender<Result<Vec<u8>, String>>,
    ) {
        if view.is_null() {
            let _ = tx.send(Err("webview 句柄是空的".into()));
            return;
        }
        // 先验明正身再发 WKWebView 的选择子。指针来自 wry 的 content view，
        // 万一它不是 WKWebView，`unrecognized selector` 是进程级 abort ——
        // 前端那套「失败就回退」接不住崩溃，所以这道检查不是洁癖。
        // `downcast_ref` 走的就是 `isKindOfClass:`，wry 那个 WKWebView 子类也算数。
        let object: &AnyObject = unsafe { &*view.cast::<AnyObject>() };
        let Some(view) = object.downcast_ref::<WKWebView>() else {
            let _ = tx.send(Err("webview 句柄不是 WKWebView".into()));
            return;
        };
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err("截屏不在主线程上".into()));
            return;
        };
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        let rect =
            NSRect::new(NSPoint::new(region.x, region.y), NSSize::new(region.width, region.height));
        unsafe { config.setRect(rect) };

        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            // SAFETY: 完成回调只在主线程被调用一次，参数是 WebKit 给的
            // NSImage / NSError（后者可能为空）。
            let _ = tx.send(unsafe { png_of(image, error) });
        });
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block) };
    }

    /// NSImage → PNG。走 TIFF 表示是多一次拷贝，但翻页一次才叫一回来，
    /// 省下的是 CoreGraphics 那一整套。
    ///
    /// SAFETY: 主线程；`image` 是 WebKit 交出来的 NSImage 或空指针。
    unsafe fn png_of(image: *mut NSImage, error: *mut NSError) -> Result<Vec<u8>, String> {
        if image.is_null() {
            return Err(unsafe { error_message(error) });
        }
        let image = unsafe { &*image };
        let tiff = image.TIFFRepresentation().ok_or("快照没有 TIFF 表示")?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("快照的 TIFF 解不出来")?;
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
        .ok_or("PNG 编码失败")?;
        let bytes = png.to_vec();
        if bytes.is_empty() {
            return Err("PNG 编码没有数据".into());
        }
        Ok(bytes)
    }

    /// SAFETY: `error` 是 NSError 或空指针。
    unsafe fn error_message(error: *mut NSError) -> String {
        if error.is_null() {
            return "快照没有图像".into();
        }
        let error = unsafe { &*error };
        format!("快照失败：{}", error.localizedDescription())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::CaptureRegion;

    /// 别的平台（Windows WebView2 / Linux webkit2gtk）还没接。
    /// 返回错误而不是空图：前端据此回退到 CSS 翻页动画。
    pub fn capture(
        _window: &tauri::WebviewWindow,
        _region: CaptureRegion,
    ) -> Result<Vec<u8>, String> {
        Err("当前平台还不支持阅读区截屏".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(width: f64, height: f64) -> CaptureRegion {
        CaptureRegion { x: 0.0, y: 0.0, width, height }
    }

    #[test]
    fn a_region_needs_two_finite_sides() {
        assert!(region(100.0, 50.0).is_sane());
        assert!(!region(0.0, 50.0).is_sane());
        assert!(!region(-1.0, 50.0).is_sane());
        assert!(!region(f64::NAN, 50.0).is_sane());
        assert!(!region(f64::INFINITY, 50.0).is_sane());
    }

    #[test]
    fn the_region_arrives_in_camel_case() {
        // 前端递过来的是 `{ x, y, width, height }`；键名写错就是「区域是 0x0」
        // 这种要在翻页时才会发现的沉默故障。
        let parsed: CaptureRegion =
            serde_json::from_str(r#"{"x":1,"y":2,"width":300,"height":400}"#).expect("deserialize");
        assert_eq!((parsed.x, parsed.y, parsed.width, parsed.height), (1.0, 2.0, 300.0, 400.0));
    }
}
