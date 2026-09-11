import { describe, expect, it } from "vitest";

import { foldScrollDelta, updateReadingSpeed } from "@/stores/reader";

describe("foldScrollDelta", () => {
  it("keeps slow speeds moving by carrying sub-pixel steps across frames", () => {
    // 40 px/s on a 120 Hz display moves 0.33 px per frame; without the carry
    // every whole-pixel write rounds back to zero and the page never scrolls.
    let carry = 0;
    let moved = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      const fold = foldScrollDelta(40, 1 / 120, carry);
      carry = fold.carry;
      moved += fold.delta;
    }
    expect(moved).toBe(40);
  });

  it("emits whole pixels immediately at fast speeds", () => {
    const fold = foldScrollDelta(480, 1 / 60, 0);
    expect(fold.delta).toBe(8);
    expect(fold.carry).toBeLessThan(1e-9);
  });
});

describe("updateReadingSpeed", () => {
  it("averages a plausible session into the estimate", () => {
    // 600 chars in 120s = 300 cpm → 0.7*300 + 0.3*300 = 300.
    expect(updateReadingSpeed(300, 600, 120_000)).toBe(300);
    // 1000 chars in 50s = 1200 cpm → 0.7*300 + 0.3*1200 = 570.
    expect(updateReadingSpeed(300, 1000, 50_000)).toBe(570);
  });

  it("ignores sessions without progress or with implausible length", () => {
    expect(updateReadingSpeed(300, 0, 120_000)).toBe(300);
    expect(updateReadingSpeed(300, 50, 3_000)).toBe(300);
    expect(updateReadingSpeed(300, 50, 3600_000)).toBe(300);
  });

  it("clamps wild samples into a sane range", () => {
    // 10000 chars in 10s = far beyond the ceiling.
    expect(updateReadingSpeed(300, 10_000, 10_000)).toBe(300 * 0.7 + 1500 * 0.3);
  });
});
