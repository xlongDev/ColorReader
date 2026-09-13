/**
 * How many device pixels to rasterise one pdf.js page at.
 *
 * The canvas bitmap is displayed at `fitScale * zoom` CSS pixels, so the
 * ratio that keeps a zoomed page as sharp as a fitted one is the device pixel
 * ratio itself — the page is drawn at the size it is shown at, never
 * stretched from the fitted bitmap. The ratio only gives way when the
 * full-resolution bitmap would outgrow what WebKit will back, which takes a
 * high zoom on an outsized page.
 */

/** Device pixels one canvas may hold. WebKit hands back a blank canvas past
 *  roughly 16.7 Mpx (4096²), so the ratio yields before reaching it. */
const MAX_CANVAS_PIXELS = 16_777_216;

/** Highest ratio worth rasterising at: a 3× panel gains nothing legible over
 *  2×, and every step of ratio costs four times the bitmap. */
export const MAX_DPR = 2;

export function canvasRatio(opts: {
  /** Page width and height in PDF units, rotation already applied. */
  unitWidth: number;
  unitHeight: number;
  /** CSS pixels per PDF unit at zoom 1. */
  fitScale: number;
  /** Caller zoom, 1 = fitted. */
  zoom: number;
  /** Device pixel ratio, before capping. */
  dpr: number;
}): number {
  const scale = opts.fitScale * Math.max(opts.zoom, 0.01);
  const area = opts.unitWidth * opts.unitHeight * scale * scale;
  // A zero-sized page (a broken /MediaBox) has nothing to rasterise; the
  // wrapper's own measurement decides the layout, so the ratio is moot.
  if (!(area > 0)) return MAX_DPR;
  return Math.min(opts.dpr, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

/**
 * The CSS size a page occupies: the fitted page times the zoom.
 *
 * Every writer of that box goes through here — the layout around the canvas,
 * the canvas' own box, and the re-raster after a gesture. A second expression
 * anywhere is a bug: the re-raster writes the size imperatively, and React
 * skips a style update whose value is unchanged, so a box computed even
 * slightly differently survives the re-render while the reader's zoom says
 * otherwise — a zoomed page snapping back to fit.
 */
export function displaySize(fitted: { w: number; h: number }, zoom: number) {
  return { w: Math.round(fitted.w * zoom), h: Math.round(fitted.h * zoom) };
}
