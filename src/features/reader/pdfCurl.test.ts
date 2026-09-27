import { describe, expect, it } from "vitest";

import { curlGeometry } from "./pdfCurl";

/** A sheet the width of a page in the fixture. */
const WIDTH = 900;

describe("curlGeometry", () => {
  it("starts the fold at the edge the sheet lifts from", () => {
    // Forward lifts the outer edge: the fold begins level with the sheet's
    // right edge, so nothing is turned yet.
    expect(curlGeometry(WIDTH, 0, 1).offset).toBe(WIDTH);
    // Backward lifts the spine side instead.
    expect(curlGeometry(WIDTH, 0, -1).offset).toBe(0);
  });

  it("has carried the whole sheet past the fold by the end", () => {
    for (const dir of [1, -1] as const) {
      const { radius, offset } = curlGeometry(WIDTH, 1, dir);
      // How far the sheet's far edge sits past the fold, in the direction the
      // turn travels. Exactly one arc's worth is the fold clearing the sheet:
      // less and a strip of the old page is left lying on the new one, more
      // and the sheet is still moving after the turn is meant to have landed.
      const past = dir === 1 ? -offset : offset - WIDTH;
      expect(past).toBeCloseTo(Math.PI * radius, 6);
    }
  });

  it("tightens the curl as it travels, with a floor for narrow sheets", () => {
    const start = curlGeometry(WIDTH, 0, 1).radius;
    const end = curlGeometry(WIDTH, 1, 1).radius;
    expect(end).toBeLessThan(start);
    expect(end).toBeCloseTo(start * 0.6, 6);
    // A sliver of a page still bends like paper, not like a hinge.
    expect(curlGeometry(40, 0, 1).radius).toBe(24);
  });
});
