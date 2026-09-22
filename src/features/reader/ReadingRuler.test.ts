import { describe, expect, it } from "vitest";

import { rulerStepForKey } from "@/features/reader/ReadingRuler";

/**
 * Which arrow keys the ruler claims while it is on.
 *
 * This is the whole keyboard contract, and it is one function because of it: the
 * page's own handler asks this first and only turns the page when the band says
 * there is no block left in that direction.
 */
describe("rulerStepForKey", () => {
  it("steps the band with all four arrows in horizontal type", () => {
    // Horizontal type reads down the page, so left and right are the same step
    // as up and down — there is no second axis for them to mean.
    expect(rulerStepForKey("ArrowDown", false)).toBe(1);
    expect(rulerStepForKey("ArrowUp", false)).toBe(-1);
    expect(rulerStepForKey("ArrowRight", false)).toBe(1);
    expect(rulerStepForKey("ArrowLeft", false)).toBe(-1);
  });

  it("leaves left and right to the page turns in vertical type", () => {
    // Vertical-rl reads leftward, where Left/Right are the page turns the reader
    // already knows. The band is stepped by up and down, and the reference draws
    // the line in the same place.
    expect(rulerStepForKey("ArrowDown", true)).toBe(1);
    expect(rulerStepForKey("ArrowUp", true)).toBe(-1);
    expect(rulerStepForKey("ArrowLeft", true)).toBe(0);
    expect(rulerStepForKey("ArrowRight", true)).toBe(0);
  });

  it("leaves every other key alone", () => {
    // Space, PageUp/PageDown and the media keys are the page-turner keys, and a
    // key the band claimed would never reach them.
    for (const key of [" ", "PageDown", "PageUp", "MediaTrackNext", "j", "Escape"]) {
      expect(rulerStepForKey(key, false)).toBe(0);
      expect(rulerStepForKey(key, true)).toBe(0);
    }
  });
});
