import { describe, expect, it } from "vitest";

import { updateReadingSpeed } from "@/stores/reader";
import { SPEECH_RATES, nextSpeechRate } from "@/stores/reader";

describe("nextSpeechRate", () => {
  it("cycles through every rate and wraps around", () => {
    let rate: number = SPEECH_RATES[0];
    for (let step = 1; step <= SPEECH_RATES.length; step += 1) {
      rate = nextSpeechRate(rate);
      expect(rate).toBe(SPEECH_RATES[step % SPEECH_RATES.length]);
    }
  });

  it("treats an unknown rate as the start of the cycle", () => {
    expect(nextSpeechRate(3)).toBe(SPEECH_RATES[0]);
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
