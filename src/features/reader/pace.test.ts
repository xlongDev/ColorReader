import { describe, expect, it } from "vitest";

import {
  foldPace,
  medianCpm,
  MIN_PACE_SAMPLES,
  NO_PACE,
  PACE_WINDOW,
  pushPace,
  type PaceSample,
} from "@/features/reader/pace";

/** One minute at 300 chars/minute — an ordinary stretch of reading. */
const READING: PaceSample = { chars: 300, ms: 60_000 };

describe("foldPace", () => {
  it("holds a stretch open until it is long enough to mean something", () => {
    const first = foldPace(NO_PACE, 50, 2_000);
    expect(first.sample).toBeNull();

    const second = foldPace(first.acc, 50, 2_000);
    expect(second.sample).toBeNull();
    // Both thresholds, not either: 400 chars in two seconds is a jump, and
    // ten seconds over 20 characters is a scroll past a heading.
    expect(foldPace(second.acc, 300, 200).sample).toBeNull();
    expect(foldPace(second.acc, 0, 8_000).sample).toBeNull();
  });

  it("closes a stretch that reaches both thresholds", () => {
    const folded = foldPace(NO_PACE, 400, 15_000);
    expect(folded.sample).toEqual({ chars: 400, ms: 15_000 });
    expect(folded.acc).toEqual(NO_PACE);
  });

  it("throws away a stretch the reader spent away from", () => {
    // Ten minutes of app-open, no text read: recording it would put the
    // average's problem back into the window.
    const open = foldPace({ chars: 120, ms: 20_000 }, 0, 600_000);
    expect(open.sample).toBeNull();
    expect(open.acc).toEqual(NO_PACE);
  });

  it("keeps a slow stretch that was genuinely read", () => {
    // Same ten minutes, but 800 characters were read in it: a slow reader,
    // not an absent one.
    const open = foldPace({ chars: 0, ms: 0 }, 800, 600_000);
    expect(open.sample).toEqual({ chars: 800, ms: 600_000 });
  });
});

describe("pushPace", () => {
  it("keeps the window bounded and drops the oldest", () => {
    let samples: PaceSample[] = [];
    for (let i = 0; i < PACE_WINDOW + 5; i += 1) {
      samples = pushPace(samples, { chars: 100 + i, ms: 30_000 });
    }
    expect(samples).toHaveLength(PACE_WINDOW);
    expect(samples[0]!.chars).toBe(105);
    expect(samples.at(-1)!.chars).toBe(100 + PACE_WINDOW + 4);
  });
});

describe("medianCpm", () => {
  it("needs a handful of stretches before it speaks", () => {
    const few = Array.from({ length: MIN_PACE_SAMPLES - 1 }, () => READING);
    expect(medianCpm(few)).toBeNull();
    expect(medianCpm(Array.from({ length: MIN_PACE_SAMPLES }, () => READING))).toBe(300);
  });

  it("ignores one stretch where the reader was away", () => {
    // The mean of these is 165 cpm — a 45% underestimate of pace, which is
    // the whole reason this is a median.
    const samples = [{ chars: 10, ms: 600_000 }, ...Array.from({ length: 8 }, () => READING)];
    expect(medianCpm(samples)).toBe(300);
  });

  it("ignores a stretch that is not reading at all", () => {
    // A jump to the last chapter: 40k chars in one second. Clamping it would
    // leave a fake outlier sitting in the middle of the window.
    const samples = [{ chars: 40_000, ms: 1_000 }, ...Array.from({ length: 8 }, () => READING)];
    expect(medianCpm(samples)).toBe(300);
  });

  it("averages the middle two of an even window", () => {
    const samples: PaceSample[] = [
      { chars: 200, ms: 60_000 },
      { chars: 300, ms: 60_000 },
      { chars: 400, ms: 60_000 },
      { chars: 500, ms: 60_000 },
      { chars: 600, ms: 60_000 },
      { chars: 700, ms: 60_000 },
    ];
    expect(medianCpm(samples)).toBe(450);
  });
});
