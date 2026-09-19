import { describe, expect, it } from "vitest";

import {
  canvasRatio,
  displaySize,
  hasRaster,
  MAX_DPR,
  MAX_RASTERS,
  pageScales,
  putRaster,
  rasterKeyOf,
  takeRaster,
  type PageRaster,
} from "./pdfCanvas";

/** A typical trade-paperback page in PDF units, fitted into a paged column. */
const PAGE = { unitWidth: 595, unitHeight: 842, fitScale: 0.74 };

/** Device pixels the bitmap holds for one render at `ratio`. */
const bitmapPixels = (opts: Parameters<typeof canvasRatio>[0], ratio: number) =>
  opts.unitWidth * opts.unitHeight * (ratio * opts.fitScale * opts.zoom) ** 2;

/** The ratio solves `area = budget` exactly where the budget binds, so this
    allows for float rounding. */
const expectWithinBudget = (opts: Parameters<typeof canvasRatio>[0], ratio: number) =>
  expect(bitmapPixels(opts, ratio)).toBeLessThanOrEqual(16_777_216 * (1 + 1e-9));

describe("canvasRatio", () => {
  it("rasterises a fitted page at the device pixel ratio", () => {
    expect(canvasRatio({ ...PAGE, zoom: 1, dpr: 2 })).toBe(2);
  });

  it("holds the device pixel ratio at the zoom the header steps to", () => {
    // The bug this exists for: 297% used to stretch the 0.74-scale bitmap.
    expect(canvasRatio({ ...PAGE, zoom: 2.97, dpr: 2 })).toBe(2);
  });

  it("gives up a sliver of resolution only once the canvas budget binds", () => {
    const opts = { ...PAGE, zoom: 4, dpr: 2 };
    const ratio = canvasRatio(opts);
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2);
    expectWithinBudget(opts, ratio);
  });

  it("caps at 2 on a small page where the bitmap is cheap", () => {
    const ratio = canvasRatio({ unitWidth: 200, unitHeight: 300, fitScale: 1, zoom: 1, dpr: 2 });
    expect(ratio).toBe(MAX_DPR);
  });

  it("yields resolution rather than lose the canvas on an outsized page", () => {
    const opts = { unitWidth: 1191, unitHeight: 1684, fitScale: 1, zoom: 4, dpr: 2 };
    const ratio = canvasRatio(opts);
    expect(ratio).toBeLessThan(1);
    expectWithinBudget(opts, ratio);
  });

  it("keeps a degenerate page box from dividing by zero", () => {
    expect(canvasRatio({ unitWidth: 0, unitHeight: 0, fitScale: 1, zoom: 2, dpr: 2 })).toBe(
      MAX_DPR,
    );
  });
});

describe("displaySize", () => {
  /** A trade-paperback page fitted into a paged column, at CSS pixel sizes. */
  const fitted = { w: 440, h: 623 };

  it("shows a fitted page at its fitted size", () => {
    expect(displaySize(fitted, 1)).toEqual(fitted);
  });

  it("carries the zoom into the box", () => {
    // The regression this guards: the re-raster wrote the *fitted* size, and
    // React skips a style update whose value is unchanged, so the page kept
    // that box the moment the zoom settled and snapped back to fit.
    expect(displaySize(fitted, 4)).toEqual({ w: 1760, h: 2492 });
  });

  it("rounds, so the layout stays on integer pixels", () => {
    expect(displaySize({ w: 440.4, h: 623.6 }, 2.97)).toEqual({ w: 1308, h: 1852 });
  });
});

describe("pageScales", () => {
  /** A page box a maximised reader gives a PDF on a Retina panel. */
  const BOX = { boxWidth: 1600, boxHeight: 2200, dpr: 2 };

  it("fills the width and lets the height fall where it may in width mode", () => {
    // The regression this guards: the scroll layout fits width only, so a
    // taller-than-the-box page must keep scaling rather than shrink to fit.
    const { fitScale } = pageScales({ ...PAGE, ...BOX, fit: "width", zoom: 1 });
    expect(fitScale).toBeCloseTo(1600 / 595, 6);
  });

  it("fits both axes in box mode, so one page is one screen", () => {
    const { fitScale } = pageScales({ ...PAGE, ...BOX, fit: "box", zoom: 1 });
    expect(fitScale).toBeCloseTo(Math.min(1600 / 595, 2200 / 842), 6);
  });

  it("draws the bitmap at the fitted size times the zoom times the ratio", () => {
    const { fitScale, rasterScale } = pageScales({ ...PAGE, ...BOX, fit: "box", zoom: 1 });
    expect(rasterScale).toBeCloseTo(fitScale * 1 * 2, 6);
  });

  it("scales the bitmap with the zoom while the canvas has headroom", () => {
    const box = { boxWidth: 600, boxHeight: 900, dpr: 2 };
    const at1 = pageScales({ ...PAGE, ...box, fit: "box", zoom: 1 }).rasterScale;
    const at2 = pageScales({ ...PAGE, ...box, fit: "box", zoom: 2 }).rasterScale;
    expect(at2).toBeCloseTo(at1 * 2, 6);
  });

  it("stops gaining resolution once the canvas budget binds, never before", () => {
    const { rasterScale } = pageScales({ ...PAGE, ...BOX, fit: "box", zoom: 3 });
    const area = PAGE.unitWidth * PAGE.unitHeight * rasterScale * rasterScale;
    expect(area).toBeLessThanOrEqual(16_777_216 * (1 + 1e-9));
    // Still finer than the fitted bitmap — the ceiling is the canvas, never a
    // stretched page.
    const { rasterScale: atFit } = pageScales({ ...PAGE, ...BOX, fit: "box", zoom: 1 });
    expect(rasterScale).toBeGreaterThan(atFit);
  });

  it("keeps a degenerate page box from dividing by zero", () => {
    const { fitScale, rasterScale } = pageScales({
      unitWidth: 0,
      unitHeight: 0,
      ...BOX,
      fit: "box",
      zoom: 1,
    });
    expect(fitScale).toBe(0);
    expect(Number.isFinite(rasterScale)).toBe(true);
  });
});

describe("rasterKeyOf", () => {
  const base = {
    bookId: "b1",
    pageNumber: 3,
    fit: "box" as const,
    boxWidth: 1600,
    boxHeight: 2200,
    zoom: 1,
    dpr: 2,
    nightFg: null,
    nightBg: null,
    invertImages: false,
  };

  it("is stable for the same inputs", () => {
    expect(rasterKeyOf(base)).toBe(rasterKeyOf({ ...base }));
  });

  it("changes for every input a raster's pixels depend on", () => {
    // The store's whole correctness argument: a prefetched bitmap is only
    // served if the key still describes what would be rendered now. One field
    // missing here is a page served at the wrong size, in the wrong colours,
    // or with the wrong images inverted.
    const mutations = {
      bookId: "b2",
      pageNumber: 4,
      fit: "width" as const,
      boxWidth: 1601,
      boxHeight: 2201,
      zoom: 2,
      dpr: 1,
      nightFg: "#e8e2d4",
      nightBg: "#14100c",
      invertImages: true,
    };
    for (const [field, value] of Object.entries(mutations)) {
      expect(rasterKeyOf({ ...base, [field]: value }), field).not.toBe(rasterKeyOf(base));
    }
  });
});

/** A canvas with dimensions but no context — jsdom has no 2d, and only the
    bitmap's size matters to the store. */
function raster(): PageRaster {
  const bitmap = document.createElement("canvas");
  bitmap.width = 8;
  bitmap.height = 8;
  return { bitmap, fitted: { w: 8, h: 8 } };
}

describe("the raster store", () => {
  it("holds one forward spread and no more", () => {
    expect(MAX_RASTERS).toBe(2);
  });

  it("hands back what it was given, and keeps it for the turn back", () => {
    const put = raster();
    putRaster("keep", put);
    expect(takeRaster("keep")).toBe(put);
    expect(takeRaster("keep")).toBe(put);
  });

  it("answers null for a page it has never seen", () => {
    expect(takeRaster("never-stored")).toBeNull();
    expect(hasRaster("never-stored")).toBe(false);
  });

  it("drops the oldest and frees its bitmap, not just its reference", () => {
    const first = raster();
    putRaster("evict-1", first);
    putRaster("evict-2", raster());
    putRaster("evict-3", raster());
    expect(hasRaster("evict-1")).toBe(false);
    // Dropping the reference is not enough: an HTMLCanvasElement keeps its
    // backing store until its dimensions go to zero.
    expect(first.bitmap.width).toBe(0);
    expect(first.bitmap.height).toBe(0);
    expect(hasRaster("evict-2")).toBe(true);
    expect(hasRaster("evict-3")).toBe(true);
  });
});
