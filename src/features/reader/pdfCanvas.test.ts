import { describe, expect, it } from "vitest";

import { canvasRatio, displaySize, MAX_DPR } from "./pdfCanvas";

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
