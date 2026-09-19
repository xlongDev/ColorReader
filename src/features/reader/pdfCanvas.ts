/**
 * How many device pixels to rasterise one pdf.js page at, and who is holding a
 * finished raster.
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
 * The two scales one page needs: `fitScale` is CSS pixels per PDF unit at
 * zoom 1 (it sizes the layout box), `rasterScale` is what pdf.js draws at —
 * fit × zoom, times the device ratio the canvas can afford.
 *
 * Both the page the reader is waiting on and the one prefetched behind their
 * back go through here. A second expression anywhere is a bug: the prefetched
 * bitmap is filed under a key derived from these numbers, and a raster that
 * came out even slightly differently from what the foreground render would
 * have produced must never be accepted as a hit.
 */
export function pageScales(opts: {
  unitWidth: number;
  unitHeight: number;
  /** The wrapper the page has to fit into, in CSS pixels. */
  boxWidth: number;
  boxHeight: number;
  /** "width" fills the box's width only; "box" fits both axes. */
  fit: "width" | "box";
  /** Caller zoom, 1 = fitted. */
  zoom: number;
  dpr: number;
}): { fitScale: number; rasterScale: number } {
  const { unitWidth, unitHeight, boxWidth, boxHeight, fit, zoom, dpr } = opts;
  const widthScale = unitWidth > 0 ? boxWidth / unitWidth : 0;
  const fitScale =
    fit === "box" && unitHeight > 0 ? Math.min(widthScale, boxHeight / unitHeight) : widthScale;
  return {
    fitScale,
    rasterScale:
      Math.max(fitScale * zoom, 0.01) * canvasRatio({ unitWidth, unitHeight, fitScale, zoom, dpr }),
  };
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

/** A rasterised page, ready to blit, plus the layout box it was fitted to. */
export interface PageRaster {
  bitmap: HTMLCanvasElement;
  fitted: { w: number; h: number };
}

/**
 * Everything a raster's pixels depend on. Two renders agree only if all of
 * this agrees, so a key that leaves one out serves a page at the wrong size,
 * in the wrong colours, or with the wrong images inverted.
 *
 * The wrapper's measured box is in here rather than the derived scale: the
 * box is known synchronously, before `getPage` resolves, and the scale is a
 * function of the box and the page's own dimensions.
 */
export function rasterKeyOf(parts: {
  bookId: string;
  pageNumber: number;
  fit: "width" | "box";
  boxWidth: number;
  boxHeight: number;
  zoom: number;
  dpr: number;
  nightFg: string | null | undefined;
  nightBg: string | null | undefined;
  invertImages: boolean;
}): string {
  return [
    parts.bookId,
    parts.pageNumber,
    parts.fit,
    `${parts.boxWidth}x${parts.boxHeight}`,
    parts.zoom,
    parts.dpr,
    parts.nightFg ?? "",
    parts.nightBg ?? "",
    parts.invertImages ? 1 : 0,
  ].join("|");
}

/**
 * Rasters held for pages the reader has not asked for yet.
 *
 * `ponytail:` two entries — one forward spread, which is what makes the next
 * turn instant. A back-turn beyond one step re-renders, and that is the
 * deliberate trade: keeping history would double the memory for a gesture
 * readers make far less often. At 2× dpr a page-sized bitmap is ~10–25 MB, so
 * two is 20–50 MB held on top of the live canvas. Raise it only alongside a
 * budget for what a page is allowed to cost.
 */
export const MAX_RASTERS = 2;
const rasters = new Map<string, PageRaster>();

/** Releases a bitmap's backing store. Dropping the reference is not enough:
 *  an `HTMLCanvasElement` keeps its memory until its dimensions go to zero. */
function release(raster: PageRaster): void {
  raster.bitmap.width = 0;
  raster.bitmap.height = 0;
}

export function hasRaster(key: string): boolean {
  return rasters.has(key);
}

/** The raster for `key`, or null. Kept in the store — a turn back is a hit. */
export function takeRaster(key: string): PageRaster | null {
  return rasters.get(key) ?? null;
}

export function putRaster(key: string, raster: PageRaster): void {
  // Re-inserting refreshes insertion order, so the Map's first key is always
  // the least recently *stored* one.
  rasters.delete(key);
  rasters.set(key, raster);
  while (rasters.size > MAX_RASTERS) {
    const oldest = rasters.keys().next().value as string;
    const dropped = rasters.get(oldest);
    rasters.delete(oldest);
    if (dropped) release(dropped);
  }
}
