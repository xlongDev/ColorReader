import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { loadDoc } from "@/lib/pdf";

import { installNightContext } from "./pdfNightContext";

/** One rendered PDF page. Fixed layout is the point: fonts, spacing and
    illustrations come out exactly as the document drew them, which text
    extraction can never reproduce. */

type RenderState = "loading" | "ready" | "error";

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
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<{ cancel: () => void } | null>(null);
  const [state, setState] = useState<RenderState>("loading");
  /** Fitted CSS size at zoom 1; zoom rescales it in JSX. */
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);

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
        if (!cancelled) setState("ready");
      } catch (error) {
        // A cancelled render is bookkeeping, not a failure.
        const name = (error as { name?: string }).name;
        if (!cancelled && name !== "RenderingCancelledException") setState("error");
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
      restore?.();
    };
  }, [bookId, pageNumber, fit, nightFg, nightBg, invertImages]);

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {/* ponytail: zoom is CSS-only over a dpr-capped bitmap, so >2x turns
          soft on non-retina screens; re-render at the zoomed scale if that
          ever bothers anyone. */}
      <canvas
        ref={canvasRef}
        className={cn(
          "border-hairline mx-auto block rounded-lg border",
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
