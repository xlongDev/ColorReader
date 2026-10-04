import { describe, expect, it } from "vitest";

import { timeStretch } from "./timeStretch";

/** The service's own sample rate, and the one the context decodes to. */
const RATE = 24_000;

/** A pure tone, so "the pitch did not move" is one number: a sine crosses zero
 *  twice per period, so crossings per second is twice its frequency. */
function tone(frequency: number, seconds: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * frequency * i) / RATE);
  }
  return out;
}

function crossingsPerSecond(samples: Float32Array<ArrayBuffer>): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings += 1;
  }
  return crossings / (samples.length / RATE);
}

describe("timeStretch", () => {
  it("makes it shorter when faster and longer when slower", () => {
    const input = tone(440, 1);
    expect(timeStretch(input, RATE, 1.5).length / RATE).toBeLessThan(0.75);
    expect(timeStretch(input, RATE, 0.5).length / RATE).toBeGreaterThan(1.8);
  });

  it("keeps the pitch, which a resample would not", () => {
    const input = tone(440, 1);
    const expected = 2 * 440;

    // This is the assertion that separates WSOLA from `playbackRate`: a
    // resample to 1.5× moves 440Hz to 660, which is 50% off, and half speed
    // would drop it to 220. Both have to stay near the original.
    for (const tempo of [0.5, 1.5, 2]) {
      const stretched = timeStretch(input, RATE, tempo);
      expect(Math.abs(crossingsPerSecond(stretched) / expected - 1)).toBeLessThan(0.05);
    }
  });

  it("hands tempo 1 back unchanged", () => {
    const input = tone(440, 0.2);
    expect(timeStretch(input, RATE, 1)).toEqual(input);
  });

  it("passes a clip too short to hold two frames straight through", () => {
    const input = new Float32Array(500).fill(0.5);
    expect(timeStretch(input, RATE, 1.5)).toEqual(input);
  });

  it("never divides by a silent window", () => {
    const stretched = timeStretch(new Float32Array(RATE), RATE, 1.5);
    expect(stretched.length).toBeGreaterThan(0);
    for (const sample of stretched) expect(Number.isFinite(sample)).toBe(true);
  });
});
