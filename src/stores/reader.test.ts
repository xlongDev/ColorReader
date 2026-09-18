import { describe, expect, it } from "vitest";

import { foldScrollDelta, updateReadingSpeed, useReaderSettings } from "@/stores/reader";

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

/**
 * The page indicator's boolean became a three-way scope in v7. A migration that
 * drops it is invisible until a reader who had page numbers on opens a book and
 * finds them gone, so it is pinned rather than trusted.
 *
 * `scopeOf` sits at module scope because it reads the store's live options at
 * call time and captures nothing; inside the `describe` it would be rebuilt per
 * call for no reason.
 */
function scopeOf(persisted: Record<string, unknown>): string {
  const options = useReaderSettings.persist.getOptions();
  if (!options.migrate) throw new Error("the store lost its migrate function");
  return (options.migrate(persisted, 6) as { pageNumbers: string }).pageNumbers;
}

describe("v7 page-number scope migration", () => {
  it("carries a stored `true` over as the display it already had", () => {
    expect(scopeOf({ showPageNumbers: true })).toBe("chapter");
  });

  it("leaves an off indicator off", () => {
    expect(scopeOf({ showPageNumbers: false })).toBe("off");
    expect(scopeOf({})).toBe("off");
  });

  it("keeps a scope it already understands, and refuses one it does not", () => {
    expect(scopeOf({ pageNumbers: "book" })).toBe("book");
    // Not a value this version knows: the row would otherwise render with no
    // chip selected, which is worse than losing the preference.
    expect(scopeOf({ pageNumbers: "spread" })).toBe("off");
  });
});
