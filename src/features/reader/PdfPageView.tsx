import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { loadDoc } from "@/lib/pdf";
import type { Annotation } from "@/types/ipc";

import { canvasRatio, displaySize, MAX_DPR } from "./pdfCanvas";
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
import { selectionBottom } from "./selection";

/** One rendered PDF page. Fixed layout is the point: fonts, spacing and
    illustrations come out exactly as the document drew them, which text
    extraction can never reproduce. */

type RenderState = "loading" | "ready" | "error";

/** Stable empty default so the paint effect's deps stay identity-safe. */
const EMPTY: Annotation[] = [];

/** How long a zoom must rest before the page is re-rasterised at the new
    scale. Long enough that a pinch — or a held zoom key — costs one render,
    short enough that it lands while the page is still under the eye. */
const ZOOM_SETTLE_MS = 240;

/**
 * Draws page `pageNumber` (1-based) into a canvas, sized to fill its wrapper.
 * Re-renders when the wrapper resizes; `fit` picks between filling the width
 * (scroll layout) and the whole box (paged layouts). `zoom` rescales the page
 * in CSS straight away so a pinch stays responsive, then re-rasterises the
 * bitmap at that scale once the gesture rests: a page shown at 300% is drawn
 * at 300%, not stretched from the bitmap rasterised for the fitted size.
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
  /** A completed text-layer selection, with its viewport rect for the pill.
   *  `bottom` is the lowest line that really carries text — see
   *  `selectionBottom` for why the rect's own bottom can be a line too low. */
  onSelection?: (range: TextRange, rect: DOMRect, bottom: number) => void;
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
  /** The zoom the next raster is drawn at. Lags `zoom` so a pinch redraws
      once, when it rests, instead of on every frame. */
  const rasterZoomRef = useRef(zoom);
  /** This render's own entry point. A zoom re-raster goes through it rather
      than through the effect's deps: restarting the effect would clear the
      page's highlights and read-aloud wash, which belong to the page, not to
      the bitmap. */
  const schedulerRef = useRef<() => void>(() => {});
  /** Canvas signature already painted, and the scale the text layer was built
      at. A zoom change refreshes the bitmap but leaves the layer alone. */
  const paintedRef = useRef("");
  const layeredRef = useRef("");

  useEffect(() => {
    const timer = setTimeout(() => {
      if (rasterZoomRef.current === zoom) return;
      rasterZoomRef.current = zoom;
      schedulerRef.current();
    }, ZOOM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [zoom]);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;

    const render = async () => {
      // Only the first raster of this box announces itself. Once a page is up,
      // a turn — or a zoom, or a theme flip — keeps it on screen until the new
      // bitmap is ready; announcing a load would blank the page the reader is
      // looking at, which is the flash this exists to avoid.
      const signature = `${pageNumber}|${fit}|${nightFg}|${nightBg}|${invertImages}`;
      if (paintedRef.current === "") setState("loading");
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
        // The bitmap spans the zoomed page, not the fitted one: the canvas is
        // displayed at `fitted × zoom`, so rasterising at `scale × zoom` keeps
        // one bitmap pixel per device pixel however far the reader zooms in.
        const zoomToRaster = rasterZoomRef.current;
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const viewport = page.getViewport({
          scale:
            Math.max(scale * zoomToRaster, 0.01) *
            canvasRatio({
              unitWidth: unit.width,
              unitHeight: unit.height,
              fitScale: scale,
              zoom: zoomToRaster,
              dpr,
            }),
        });

        // `fitted` is the page at zoom 1; both the layout and the write below
        // scale it by the zoom. An explicit size — not `width: 100%` — is what
        // makes "box" fit actually shrink the page into the visible box
        // instead of clipping its bottom off.
        const fitted = {
          w: Math.floor(unit.width * scale),
          h: Math.floor(unit.height * scale),
        };
        setBase(fitted);
        // Written at the size the page is *shown* at, zoom included — the same
        // size JSX gives the canvas. React skips a style write whose value is
        // unchanged, so a fit-sized pair here would survive the re-render
        // `setBase` triggers and snap a zoomed page back to fit the moment the
        // raster landed.
        const shown = displaySize(fitted, zoomToRaster);
        canvas.style.width = `${shown.w}px`;
        canvas.style.height = `${shown.h}px`;

        // The raster lands in a detached canvas and is blitted in one frame,
        // so the page already on screen survives the whole render — a turn
        // never shows an empty box while pdf.js works. (readest does the same:
        // it builds the canvas off-DOM and swaps it in.)
        const scratch = document.createElement("canvas");
        scratch.width = Math.floor(viewport.width);
        scratch.height = Math.floor(viewport.height);
        // The night wrapper goes on the scratch canvas, not the visible one:
        // pdf.js v6 discards a handed-in `canvasContext` as soon as `canvas` is
        // set and calls `getContext("2d")` on that element itself. Installing
        // it before the context is fetched means both routes hand pdf.js the
        // wrapped one. Still per-canvas, so the shelf's cover renderer in
        // lib/pdf.ts keeps the document's real colours.
        const restoreScratch =
          nightFg && nightBg ? installNightContext(scratch, nightFg, nightBg, invertImages) : null;
        const scratchContext = scratch.getContext("2d");
        if (!scratchContext) {
          restoreScratch?.();
          return;
        }

        taskRef.current?.cancel();
        // `background` is the paper the page is painted on; without it pdf.js
        // defaults to white and the whole page glares.
        const task = page.render({
          canvas: scratch,
          canvasContext: scratchContext,
          viewport,
          ...(nightBg ? { background: nightBg } : {}),
        });
        taskRef.current = task;
        try {
          await task.promise;
        } finally {
          restoreScratch?.();
        }
        if (cancelled) return;

        // Same task, so the browser never paints between the clear and the
        // blit: the swap is atomic on screen.
        canvas.width = scratch.width;
        canvas.height = scratch.height;
        canvas.getContext("2d")?.drawImage(scratch, 0, 0);
        // Release the scratch bitmap before the text layer builds; at 2x dpr a
        // page-sized one is ~10 MB.
        scratch.width = 0;
        scratch.height = 0;
        paintedRef.current = signature;
        setState("ready");

        // The selectable text layer sits over the canvas at the page's CSS
        // size (no dpr: it must line up with layout pixels, and pdf.js scales
        // it internally by the real device pixel ratio). Rebuilt when the page
        // or the fitted size changes — never on a zoom, which the layer takes
        // through its CSS transform. Recorded only once it has rendered, so a
        // cancelled build is redone rather than left half-filled.
        const layer = layerRef.current;
        const layerKey = `${pageNumber}|${scale}`;
        if (layer && layeredRef.current !== layerKey) {
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
          layeredRef.current = layerKey;
        }
        if (!cancelled) setTextReady(true);
      } catch (error) {
        // A cancelled render is bookkeeping, not a failure, and a failure in
        // the text layer must not stamp an error over a page that did raster.
        const name = (error as { name?: string }).name;
        if (
          !cancelled &&
          name !== "RenderingCancelledException" &&
          name !== "AbortException" &&
          paintedRef.current !== signature
        ) {
          setState("error");
        }
      }
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };
    // A wrapper resize and a settled zoom are the same request: draw again.
    schedulerRef.current = schedule;
    void schedule();

    const observer = new ResizeObserver(schedule);
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => {
      schedulerRef.current = () => {};
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
      const domRange = selection.getRangeAt(0);
      const box = domRange.getBoundingClientRect();
      onSelection?.(range, box, selectionBottom(domRange.getClientRects(), box));
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

  // The box the page is shown in, at the reader's zoom — the same value the
  // re-raster writes, so a zoomed page can't be re-rendered back down to fit.
  const shown = base ? displaySize(base, zoom) : null;

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {/* Canvas and text layer share one centred box so the layer always sits
          exactly on the page, whatever the wrapper's width. The layer scales
          with `zoom` via transform: rebuilding it per pinch frame would
          thrash, and a transformed layer stays selectable and hittable. */}
      <div
        className="relative mx-auto"
        style={shown ? { width: `${shown.w}px`, height: `${shown.h}px` } : undefined}
      >
        <canvas
          ref={canvasRef}
          className={cn(
            "border-hairline block rounded-lg border",
            animated && "transition-[width,height] duration-200 ease-out",
          )}
          style={shown ? { width: `${shown.w}px`, height: `${shown.h}px` } : undefined}
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
