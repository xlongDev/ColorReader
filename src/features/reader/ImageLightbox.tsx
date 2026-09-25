import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  DownloadSimple,
  Minus,
  Plus,
} from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";

import { ipc } from "@/lib/ipc";
import { DURATION, SPRING } from "@/lib/motion";
import { assetMime } from "@/features/reader/assets";
import type { BookImage, ChapterMeta } from "@/types/ipc";

/** Lightbox zoom bounds and wheel/button step. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;

const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/**
 * The reader pane the lightbox lives over, in window coordinates. Centering
 * on the window reads as off-centre once the sidebar takes its share of the
 * width, so the viewer measures `[data-reading-viewport]` instead — the same
 * element the selection toolbar clamps against.
 */
const useReadingViewportRect = () => {
  const [rect, setRect] = useState({
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  useLayoutEffect(() => {
    const el = document.querySelector("[data-reading-viewport]");
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      setRect({ left: box.left, top: box.top, width: box.width, height: box.height });
    };
    measure();
    // The sidebar toggle and window resizes both land here as size changes
    // on the viewport, which is all the states the rect can move in.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return rect;
};

/**
 * Fullscreen image viewer over the whole book's pictures. The image scales to
 * the available box (never touching the edges), the arrows step through the
 * book's images in reading order, and each one shows where it lives with a
 * one-click jump back to its chapter.
 */
export function ImageLightbox({
  bookId,
  images,
  chapters,
  index,
  onClose,
  onIndex,
  onJump,
  urls,
}: {
  bookId: string;
  images: BookImage[];
  chapters: ChapterMeta[];
  index: number;
  onClose: () => void;
  onIndex: (next: number) => void;
  onJump: (chapterIdx: number) => void;
  /** Entry path → the URL to paint it from. The browser build passes this —
   *  foliate already decoded the picture, so its blob URL is used as handed
   *  over instead of `book_asset`, which has no browser answer. */
  urls?: Record<string, string>;
}) {
  const reduce = useReducedMotion();
  // The browser build's URL is a prop, so it takes no state at all; only the
  // desktop's fetch needs one.
  const [fetched, setFetched] = useState<string | null>(null);
  const current = images[index]!;
  const path = current.path;
  // The handed-over URL is the view's own — revoking it here would break the
  // picture the book page is still painting — so only the fetched blob gets
  // revoked in the effect below.
  const direct = urls?.[path];
  const src = direct ?? fetched;
  const location = chapters[current.chapterIdx]?.title ?? `第 ${current.chapterIdx + 1} 章`;

  // Viewer transform state: wheel/buttons zoom, the button spins, and a zoomed
  // picture pans by dragging. When the image changes, the render-time adjust
  // below resets everything for the new picture.
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  }

  // Wheel zoom needs a non-passive listener to be able to preventDefault.
  // A trackpad pinch arrives as wheel events with `ctrlKey` set (both engines
  // do this), with small continuous deltas — so it gets an exponential factor
  // instead of the discrete scroll step, and the preventDefault keeps the
  // WebView's own page magnification out of the way.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((z) =>
        event.ctrlKey || event.metaKey
          ? clampZoom(z * Math.exp(-event.deltaY * 0.01))
          : clampZoom(z * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const clampPan = (value: { x: number; y: number }) => {
    const limit = 200 * zoom;
    return {
      x: Math.min(limit, Math.max(-limit, value.x)),
      y: Math.min(limit, Math.max(-limit, value.y)),
    };
  };

  useEffect(() => {
    if (direct) return;
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        // The postMessage IPC fallback (active when the custom-protocol fetch
        // is unavailable) resolves byte arrays as plain JS arrays; normalize
        // before building the blob or it silently becomes a text blob.
        const bytes =
          buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
        url = URL.createObjectURL(new Blob([bytes], { type: assetMime(path) }));
        setFetched(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookId, path, direct]);

  const arrowClass =
    "focus-visible:focus-ring glass-solid shadow-panel text-text-1 flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-90";

  const area = useReadingViewportRect();

  return (
    <motion.div
      ref={rootRef}
      className="fixed z-[100] flex flex-col bg-black/85 p-8"
      style={{
        left: area.left,
        top: area.top,
        width: area.width,
        height: area.height,
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : DURATION.base }}
    >
      <button
        type="button"
        aria-label="关闭预览"
        className="absolute inset-0 cursor-zoom-out"
        /* Out of the tab order on purpose: it covers the viewport, so a focus
           ring on it would outline the whole screen, and it only duplicates
           what Esc and the explicit button below already do. */
        tabIndex={-1}
        onClick={onClose}
      />
      {/* Blank space passes through (pointer-events-none) to the close button
          underneath, so clicking anywhere outside the picture dismisses it. */}
      <div className="pointer-events-none relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {index > 0 && (
          <button
            type="button"
            aria-label="上一张"
            className={`${arrowClass} pointer-events-auto absolute top-1/2 left-2 z-10 -translate-y-1/2`}
            onClick={() => onIndex(index - 1)}
          >
            <CaretLeft size={16} />
          </button>
        )}
        {src && (
          <motion.img
            key={path}
            src={src}
            alt=""
            /* Opacity only, never `scale`: any transform prop makes motion
               build its own transform string, which would fight and override
               the pan/zoom/rotation `style.transform` below — the zoom
               buttons counted up while the picture never moved. */
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduce ? { duration: 0 } : SPRING.enter}
            className="shadow-panel pointer-events-auto max-h-full max-w-full rounded-xl object-contain"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              transition: dragging ? "none" : "transform var(--dur-base) var(--ease-out)",
              cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
            draggable={false}
            onDoubleClick={() => {
              if (zoom > 1) {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              } else {
                setZoom(2.5);
              }
            }}
            onPointerDown={(event) => {
              if (zoom <= 1) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStartRef.current = {
                x: event.clientX,
                y: event.clientY,
                baseX: pan.x,
                baseY: pan.y,
              };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const drag = dragStartRef.current;
              if (!drag) return;
              setPan(
                clampPan({
                  x: drag.baseX + (event.clientX - drag.x),
                  y: drag.baseY + (event.clientY - drag.y),
                }),
              );
            }}
            onPointerUp={() => {
              dragStartRef.current = null;
              setDragging(false);
            }}
          />
        )}
        {index < images.length - 1 && (
          <button
            type="button"
            aria-label="下一张"
            className={`${arrowClass} pointer-events-auto absolute top-1/2 right-2 z-10 -translate-y-1/2`}
            onClick={() => onIndex(index + 1)}
          >
            <CaretRight size={16} />
          </button>
        )}
      </div>
      <div className="relative mt-5 flex flex-wrap items-center justify-center gap-3">
        <div className="glass-solid shadow-panel pointer-events-auto flex items-center gap-1 rounded-full p-1">
          <button
            type="button"
            aria-label="缩小"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
            className="focus-visible:focus-ring text-text-1 flex h-7 w-7 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-30"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            aria-label="重置缩放与旋转"
            title="重置缩放与旋转"
            onClick={() => {
              setZoom(1);
              setRotation(0);
              setPan({ x: 0, y: 0 });
            }}
            className="focus-visible:focus-ring text-text-1 w-12 text-center text-xs tabular-nums transition-opacity hover:opacity-80"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
            className="focus-visible:focus-ring text-text-1 flex h-7 w-7 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-30"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="旋转 90 度"
            title="旋转 90 度"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="focus-visible:focus-ring text-text-1 flex h-7 w-7 items-center justify-center rounded-full transition-opacity hover:opacity-80"
          >
            <ArrowClockwise size={14} />
          </button>
        </div>
        <span className="text-xs text-white/70 tabular-nums">
          {index + 1} / {images.length}
        </span>
        <span className="text-xs text-white/70">·</span>
        <button
          type="button"
          title="跳转到图片所在章节"
          onClick={() => onJump(current.chapterIdx)}
          className="focus-visible:focus-ring text-xs text-white/70 underline-offset-4 transition-colors hover:text-white hover:underline"
        >
          第 {current.chapterIdx + 1} 章 · {location}
        </button>
        <a
          href={src ?? undefined}
          download={path.split("/").pop() || "image"}
          aria-disabled={!src}
          className="glass-solid shadow-panel text-text-1 flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs transition-opacity hover:opacity-90"
        >
          <DownloadSimple size={14} /> 保存图片
        </a>
        <button
          type="button"
          onClick={onClose}
          className="focus-visible:focus-ring glass-solid shadow-panel text-text-2 hover:text-text-1 rounded-full px-4 py-1.5 text-xs transition-colors"
        >
          关闭（Esc）
        </button>
      </div>
    </motion.div>
  );
}
