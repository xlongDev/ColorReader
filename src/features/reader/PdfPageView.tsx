import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { loadDoc } from "@/lib/pdf";
import type { Annotation } from "@/types/ipc";

import { installNightContext } from "./pdfNightContext";
import {
  clearPageHighlights,
  clearTtsWash,
  layerOffsetAtPoint,
  paintPageHighlights,
  paintTtsWash,
  locateLayerText,
  resolveLayerSelection,
} from "./pdfTextSelection";
import type { TextRange } from "./selection";

/** One rendered PDF page. Fixed layout is the point: fonts, spacing and
    illustrations come out exactly as the document drew them, which text
    extraction can never reproduce. */

type RenderState = "loading" | "ready" | "error";

/** Stable empty default so the paint effect's deps stay identity-safe. */
const EMPTY: Annotation[] = [];

/**
 * Draws page `pageNumber` (1-based) into a canvas, sized to fill its wrapper.
 * Re-renders when the wrapper resizes; `fit` picks between filling the width
 * (scroll layout) and the whole box (paged layouts). `zoom` rescales the
 * fitted page purely in CSS, so a pinch gesture never re-renders the page.
 */
export function PdfPageView({
  bookId,
  pageNumber,
  fit,
  zoom = 1,
  animated = false,
  nightFg,
  nightBg,
  invertImages = false,
  annotations = EMPTY,
  ttsWash = null,
  onSelection,
  onAnnotationClick,
}: {
  bookId: string;
  pageNumber: number;
  fit: "width" | "box";
  zoom?: number;
  /** Eases the CSS resize; pinch zooming passes false to stay direct. */
  animated?: boolean;
  /** Light end of the night axis, or null to render in the document's own
   *  colours. Plain strings, never an object: an object here would give the
   *  render effect a new dependency identity every render. */
  nightFg?: string | null;
  /** Dark end of the night axis. Doubles as the canvas ground colour. */
  nightBg?: string | null;
  /** Invert images too, for scanned PDFs that are one bright bitmap per page. */
  invertImages?: boolean;
  /** This page's saved annotations; painted onto the text layer. */
  annotations?: Annotation[];
  /** Read-aloud wash: the sentence being spoken plus the span inside it to
   *  paint (word-narrowed). Only the page whose chapter the voice is on
   *  receives it; `null` on every other page. */
  ttsWash?: { text: string; from: number; to: number } | null;
  /** A completed text-layer selection, with its viewport rect for the pill. */
  onSelection?: (range: TextRange, rect: DOMRect) => void;
  /** A click on text covered by an existing annotation. */
  onAnnotationClick?: (annotation: Annotation, x: number, y: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<{ cancel: () => void } | null>(null);
  const textTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [state, setState] = useState<RenderState>("loading");
  /** Fitted CSS size at zoom 1; zoom rescales it in JSX. */
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  /** The text layer exists and matches the current page render. */
  const [textReady, setTextReady] = useState(false);
  /** True while this page owns the read-aloud wash (see the paint effect). */
  const washPainted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    // pdf.js v6 ignores a handed-in `canvasContext` whenever `canvas` is set —
    // it calls `canvas.getContext("2d")` itself — so the night wrapper goes on
    // this one element instead. Still per-canvas, so the shelf's cover
    // renderer in lib/pdf.ts keeps the document's real colours.
    const element = canvasRef.current;
    const restore =
      element && nightFg && nightBg
        ? installNightContext(element, nightFg, nightBg, invertImages)
        : null;

    const render = async () => {
      setState("loading");
      setTextReady(false);
      textTaskRef.current?.cancel();
      try {
        const doc = await loadDoc(bookId);
        const page = await doc.getPage(pageNumber);
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (cancelled || !wrap || !canvas) return;
        if (wrap.clientWidth === 0) return;
        if (fit === "box" && wrap.clientHeight === 0) return;

        const unit = page.getViewport({ scale: 1 });
        const widthScale = wrap.clientWidth / unit.width;
        // "box" mode also fits the height, so one page = one screen, the same
        // contract a paged layout gives prose.
        const scale =
          fit === "box" ? Math.min(widthScale, wrap.clientHeight / unit.height) : widthScale;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: Math.max(scale, 0.01) * dpr });

        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // CSS size is the layout viewport (scale without dpr); the canvas
        // bitmap is dpr-scaled for sharpness. An explicit size — not
        // `width: 100%` — is what makes "box" fit actually shrink the page
        // into the visible box instead of clipping its bottom off.
        const fitted = {
          w: Math.floor(viewport.width / dpr),
          h: Math.floor(viewport.height / dpr),
        };
        setBase(fitted);
        canvas.style.width = `${fitted.w}px`;
        canvas.style.height = `${fitted.h}px`;

        taskRef.current?.cancel();
        // `background` is the paper the page is painted on; without it pdf.js
        // defaults to white and the whole page glares.
        const task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          ...(nightBg ? { background: nightBg } : {}),
        });
        taskRef.current = task;
        await task.promise;

        // The selectable text layer sits over the canvas at the page's CSS
        // size (no dpr: it must line up with layout pixels, and pdf.js scales
        // it internally by the real device pixel ratio). Rebuilt after every
        // page render — page flips and wrapper resizes both land here.
        const layer = layerRef.current;
        if (layer) {
          layer.replaceChildren();
          // pdf.js v6 rewrites the layer box itself via setLayerDimensions:
          // width: calc(var(--total-scale-factor) * pageWidth …). Without the
          // variable the calc is invalid, the container collapses to 0×0 and
          // nothing on the page is selectable. The viewer defines this as the
          // viewport's CSS scale — exactly our `scale`.
          layer.style.setProperty("--total-scale-factor", String(scale));
          const { TextLayer } = await import("pdfjs-dist");
          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: layer,
            viewport: page.getViewport({ scale: Math.max(scale, 0.01) }),
          });
          textTaskRef.current = textLayer;
          await textLayer.render();
        }
        if (!cancelled) {
          setTextReady(true);
          setState("ready");
        }
      } catch (error) {
        // A cancelled render is bookkeeping, not a failure.
        const name = (error as { name?: string }).name;
        if (!cancelled && name !== "RenderingCancelledException" && name !== "AbortException") {
          setState("error");
        }
      }
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };
    void schedule();

    const observer = new ResizeObserver(schedule);
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      taskRef.current?.cancel();
      textTaskRef.current?.cancel();
      clearPageHighlights(pageNumber);
      if (washPainted.current) {
        clearTtsWash();
        washPainted.current = false;
      }
      restore?.();
    };
  }, [bookId, pageNumber, fit, nightFg, nightBg, invertImages]);

  // Paint this page's saved annotations onto its text layer whenever either
  // side changes. `annotations` must arrive reference-stable (the parent
  // groups by page inside a memo) or this repaints every render.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !textReady) return;
    if (annotations.length === 0) {
      clearPageHighlights(pageNumber);
      return;
    }
    paintPageHighlights(pageNumber, layer, annotations);
    return () => clearPageHighlights(pageNumber);
  }, [annotations, textReady, pageNumber]);

  // Read-aloud wash: anchor the spoken sentence in this page's text layer,
  // then paint the span inside it (the whole sentence, or the word the engine
  // last reported). Only the page that owns the wash may clear it — a
  // neighbour mounting with no wash must not erase the paint.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !textReady) return;
    if (!ttsWash) {
      if (washPainted.current) {
        clearTtsWash();
        washPainted.current = false;
      }
      return;
    }
    const hit = locateLayerText(layer, ttsWash.text, ttsWash.from, ttsWash.to);
    if (!hit) return;
    paintTtsWash(layer, hit.start, hit.end);
    washPainted.current = true;
  }, [ttsWash, textReady]);

  // Selection and annotation-click handling for the text layer, attached
  // imperatively for the same reason the prose mouseup is: a selection
  // surface is pointer behaviour, not a widget, and the layer stays a plain
  // semantic div.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const onMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const range = resolveLayerSelection(layer, selection);
      if (!range) return;
      onSelection?.(range, selection.getRangeAt(0).getBoundingClientRect());
    };
    const onClick = (event: MouseEvent) => {
      // A collapsed click on annotated text opens its pill; during or right
      // after a selection this must stay inert.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const offset = layerOffsetAtPoint(event.clientX, event.clientY, layer);
      if (offset === null) return;
      const hit = annotations.find(
        (annotation) => offset >= annotation.startChar && offset < annotation.endChar,
      );
      if (hit) onAnnotationClick?.(hit, event.clientX, event.clientY);
    };
    layer.addEventListener("mouseup", onMouseUp);
    layer.addEventListener("click", onClick);
    return () => {
      layer.removeEventListener("mouseup", onMouseUp);
      layer.removeEventListener("click", onClick);
    };
  }, [annotations, onSelection, onAnnotationClick]);

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {/* ponytail: zoom is CSS-only over a dpr-capped bitmap, so >2x turns
          soft on non-retina screens; re-render at the zoomed scale if that
          ever bothers anyone. */}
      {/* Canvas and text layer share one centred box so the layer always sits
          exactly on the page, whatever the wrapper's width. The layer scales
          with `zoom` via transform: rebuilding it per pinch frame would
          thrash, and a transformed layer stays selectable and hittable. */}
      <div
        className="relative mx-auto"
        style={
          base
            ? { width: `${Math.round(base.w * zoom)}px`, height: `${Math.round(base.h * zoom)}px` }
            : undefined
        }
      >
        <canvas
          ref={canvasRef}
          className={cn(
            "border-hairline block rounded-lg border",
            animated && "transition-[width,height] duration-200 ease-out",
          )}
          style={
            base
              ? {
                  width: `${Math.round(base.w * zoom)}px`,
                  height: `${Math.round(base.h * zoom)}px`,
                }
              : undefined
          }
        />
        <div
          data-pdf-layer=""
          ref={layerRef}
          className="pdf-text-layer absolute top-0 left-0"
          style={
            base
              ? {
                  width: `${base.w}px`,
                  height: `${base.h}px`,
                  transform: `scale(${zoom})`,
                  transformOrigin: "0 0",
                }
              : undefined
          }
        />
      </div>
      {state !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-text-3 text-sm">
            {state === "loading" ? "正在渲染页面…" : "这一页渲染失败"}
          </p>
        </div>
      )}
    </div>
  );
}
