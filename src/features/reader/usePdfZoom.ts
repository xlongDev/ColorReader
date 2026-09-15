import { useCallback, useEffect, useState, type RefObject } from "react";

/** PDF zoom bounds and pinch/button step; 1 = fitted to the window. */
export const MIN_PDF_ZOOM = 0.5;
export const MAX_PDF_ZOOM = 4;
export const PDF_ZOOM_STEP = 1.25;

/** How long a button-driven zoom keeps gliding before it snaps. */
const GLIDE_MS = 260;

/**
 * Zoom of the fixed PDF pages: CSS-only over the rendered bitmap.
 *
 * Two ways in, and they must not feel the same. A button press glides — the
 * flag animates the change over a beat — while a trackpad pinch stays
 * frame-by-frame direct, so the picture tracks the fingers instead of easing
 * behind them. Hence a plain setter for the pinch and `step` for the buttons.
 */
export function usePdfZoom(scrollRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [zoom, setZoom] = useState(1);
  const [animated, setAnimated] = useState(false);

  // Trackpad pinch (macOS wheel events with ctrlKey set) zooms the PDF pages;
  // preventDefault keeps the browser's own page zoom out of the way.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom((z) =>
        Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, z * Math.exp(-event.deltaY * 0.01))),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [enabled, scrollRef]);

  const step = useCallback((factor: number) => {
    setAnimated(true);
    setZoom((z) => Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, z * factor)));
  }, []);

  useEffect(() => {
    if (!animated) return;
    const timer = window.setTimeout(() => setAnimated(false), GLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [animated]);

  return { zoom, animated, step };
}
