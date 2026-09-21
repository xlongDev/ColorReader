import { describe, expect, it } from "vitest";

import { curlGeometry } from "./pageCurl";

// A pane that is a whole number of screens wide nowhere: the assertions below
// are about the *sweep*, not about any one layout.
const W = 600;
const H = 800;

describe("curlGeometry", () => {
  it("starts flat at the grabbed edge", () => {
    const flat = curlGeometry(0, 0.5, W, H, 1, false);
    // The fold has not moved off the edge, so no vertex has s > 0 yet.
    expect(flat.fold).toEqual([W, H / 2]);
    expect(flat.radius).toBeGreaterThan(0);
  });

  it("clears the far edge by the end of the turn", () => {
    const end = curlGeometry(1, 0.5, W, H, 1, false);
    // The shader wraps everything with s < PI * radius and reflects the rest,
    // and it must still be wrapping at the *end* state's radius — otherwise the
    // first column of text is left behind, flat and unmirrored. That holds only
    // while travel carries the fold exactly one page plus a half turn of that
    // same radius.
    const endRadius = Math.max(24, 0.16 * W * 0.6);
    expect(end.radius).toBeCloseTo(endRadius, 6);
    expect(end.fold[0]).toBeCloseTo(-Math.PI * endRadius, 6);
  });

  it("sweeps one way, never back", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 20; step++) {
      const { fold } = curlGeometry(step / 20, 0.5, W, H, 1, false);
      expect(fold[0]).toBeLessThan(previous);
      previous = fold[0];
    }
  });

  it("mirrors the sweep for a right-to-left book", () => {
    for (const t of [0, 0.25, 0.5, 1]) {
      const ltr = curlGeometry(t, 0.5, W, H, 1, false).fold[0];
      const rtl = curlGeometry(t, 0.5, W, H, 1, true).fold[0];
      expect(rtl - W / 2).toBeCloseTo(-(ltr - W / 2), 6);
    }
  });

  it("folds straight by the end however the corner was grabbed", () => {
    const start = curlGeometry(0, 1, W, H, 1, false);
    // A bottom-corner grab pinches the fold diagonally at first...
    expect(start.dir[1]).toBeGreaterThan(0.5);
    // ...and the tilt decays to nothing, so the page still clears cleanly.
    expect(curlGeometry(1, 1, W, H, 1, false).dir).toEqual([1, 0]);
    for (const [t, y] of [
      [0.3, 0],
      [0.7, 1],
      [1, 0.5],
    ] as const) {
      const { dir } = curlGeometry(t, y, W, H, 1, false);
      expect(Math.hypot(dir[0], dir[1])).toBeCloseTo(1, 6);
    }
  });

  it("hinges a two-column spread at the spine", () => {
    const half = W / 2;
    for (const t of [0, 0.4, 1]) {
      // Left-to-right: only the outer (right) column is a leaf, so the inner
      // column is fenced off and cannot stretch with the hinge.
      const leaf = curlGeometry(t, 0.5, W, H, 2, false);
      expect(leaf.leaf).toEqual([half, 1e9]);
      // The roll tightens to nothing so the leaf lands flat on the inner column.
      if (t === 1) expect(leaf.radius).toBe(0);
    }
    // The fold stops exactly at the spine — one leaf width, not one page width.
    expect(curlGeometry(1, 0.5, W, H, 2, false).fold[0]).toBeCloseTo(half, 6);
    expect(curlGeometry(1, 0.5, W, H, 2, true).leaf).toEqual([-1e9, half]);
  });
});
