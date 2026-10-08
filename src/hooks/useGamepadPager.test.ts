import { describe, expect, it } from "vitest";

import {
  REPEAT_DELAY,
  REPEAT_INTERVAL,
  STICK_DEADZONE,
  heldRepeat,
  stickDirection,
  stickStep,
} from "@/hooks/useGamepadPager";

describe("stickDirection", () => {
  it("reads a resting stick as centered, not as a push", () => {
    // The reason there is a dead zone at all: a stick at rest is not reliably 0,
    // and a thumb merely resting on one reads 0.15. Below the zone is "held".
    expect(stickDirection(0)).toBe(0);
    expect(stickDirection(0.02)).toBe(0);
    expect(stickDirection(0.15)).toBe(0);
    expect(stickDirection(-0.15)).toBe(0);
    expect(stickDirection(STICK_DEADZONE - 0.01)).toBe(0);
    expect(stickDirection(-(STICK_DEADZONE - 0.01))).toBe(0);
  });

  it("reads a pushed stick as the way it points", () => {
    expect(stickDirection(0.5)).toBe(1);
    expect(stickDirection(1)).toBe(1);
    expect(stickDirection(-0.5)).toBe(-1);
    expect(stickDirection(-1)).toBe(-1);
  });

  it("takes a threshold, for a pad that rests off center", () => {
    // The same axis on a worn pad can rest at 0.3: with the default zone that
    // reads as centered (good), but a reader who knows their pad rests there can
    // hand in a tighter one.
    expect(stickDirection(0.3, 0.2)).toBe(1);
    expect(stickDirection(0.1, 0.2)).toBe(0);
  });
});

describe("heldRepeat", () => {
  it("waits longer before the first repeat than between the rest", () => {
    // Two cadences, not one: a held input that started repeating at its steady
    // rate would fire again before the reader could tell they had held it at all.
    expect(REPEAT_DELAY).toBeGreaterThan(REPEAT_INTERVAL);
  });

  it("is quiet until the delay has passed, then repeats on the interval", () => {
    expect(heldRepeat(0, 0)).toEqual({ repeats: 0, fire: false });
    expect(heldRepeat(0, REPEAT_DELAY - 1)).toEqual({ repeats: 0, fire: false });
    expect(heldRepeat(0, REPEAT_DELAY)).toEqual({ repeats: 1, fire: true });
    // Once it has repeated, the steady interval applies — and the interval is the
    // shorter of the two numbers, so a hold cannot slow down as it goes on.
    expect(heldRepeat(1, REPEAT_INTERVAL - 1)).toEqual({ repeats: 1, fire: false });
    expect(heldRepeat(1, REPEAT_INTERVAL)).toEqual({ repeats: 2, fire: true });
    expect(heldRepeat(7, 9999)).toEqual({ repeats: 8, fire: true });
  });

  it("takes both cadences, so a caller can set its own", () => {
    expect(heldRepeat(0, 50, 100, 20)).toEqual({ repeats: 0, fire: false });
    expect(heldRepeat(0, 100, 100, 20)).toEqual({ repeats: 1, fire: true });
  });
});

/**
 * One axis read frame by frame, the way the poll loop sees it — `frames` is a
 * list of `[value, msSinceItLastFired]`, and the default is a reader holding an
 * axis over for a frame with nothing happening, which is the case that must stay
 * quiet. Returns the directions it fired.
 */
const runAxis = (frames: readonly (readonly [number, number?])[], start: -1 | 0 | 1 = 0) => {
  let armed = start;
  let repeats = 0;
  const fired: number[] = [];
  for (const [value, elapsed = 16] of frames) {
    const step = stickStep(armed, repeats, value, elapsed);
    armed = step.armed;
    repeats = step.repeats;
    if (step.fire !== 0) fired.push(step.fire);
  }
  return fired;
};

describe("stickStep", () => {
  it("fires once for a push, and stays quiet while it is held", () => {
    // The whole reason a stick needs a latch: it is not a button, it is a
    // position that changes continuously, so a stick held over would otherwise
    // step a frame — a reader working down a book could never stop.
    expect(runAxis([[0.8], [0.9], [1], [1], [0.95], [0.8]])).toEqual([1]);
  });

  it("walks on while it is held, once the delay has passed", () => {
    // 🔴 A reader pushing the stick down and *keeping it there* is asking to
    // keep reading, not to advance one block and stop. That is what the hold
    // count is for: the same latch keeps it quiet and then starts the walk.
    const held: (readonly [number, number])[] = [
      [0.9, 0],
      [0.9, REPEAT_DELAY],
      [0.9, REPEAT_INTERVAL],
      [0.9, REPEAT_INTERVAL],
    ];
    expect(runAxis(held)).toEqual([1, 1, 1, 1]);
  });

  it("does not repeat before the delay, however long the frames are", () => {
    // Polled at 120fps, the elapsed time between frames is tiny; a reader who
    // holds for 300ms must not have moved three blocks.
    const frames: (readonly [number, number])[] = Array.from({ length: 24 }, () => [0.9, 12]);
    expect(runAxis(frames)).toEqual([1]);
  });

  it("fires again on the next push", () => {
    expect(
      runAxis([
        [0.8, 0],
        [0, 0],
        [0.8, 0],
        [0, 0],
        [0.8, 0],
      ]),
    ).toEqual([1, 1, 1]);
    expect(
      runAxis([
        [-0.9, 0],
        [0, 0],
        [-0.9, 0],
      ]),
    ).toEqual([-1, -1]);
  });

  it("ignores a stick that never leaves the dead zone", () => {
    // A pad lying on a desk: the axis drifts inside the zone and must read as
    // centered forever — and must never accumulate enough time to repeat.
    const idle: (readonly [number, number])[] = [
      [0.02, 0],
      [0.15, 9999],
      [-0.1, 9999],
      [0.3, 9999],
      [0.05, 9999],
    ];
    expect(runAxis(idle)).toEqual([]);
  });

  it("counts a swing across the other axis as a second push", () => {
    // Right, then up without pausing through center: the hook keeps a latch per
    // axis and this is the rule each one follows, so a swing is two deliberate
    // pushes rather than one push and a swallowed second.
    expect(
      runAxis([
        [0.9, 0],
        [0, 0],
        [-0.9, 0],
      ]),
    ).toEqual([1, -1]);
  });

  it("hands back the latch and the count, so the caller cannot forget either", () => {
    // Centered always clears both, whichever direction it was armed in — this is
    // what makes "held over is quiet, come back and it speaks again" true
    // without the caller tracking anything of its own.
    expect(stickStep(1, 3, 0, 9999)).toEqual({ armed: 0, repeats: 0, fire: 0 });
    expect(stickStep(-1, 3, 0, 9999)).toEqual({ armed: 0, repeats: 0, fire: 0 });
    expect(stickStep(0, 0, 0.7, 0)).toEqual({ armed: 1, repeats: 0, fire: 1 });
    // Held, and not yet due: the latch and the count both survive, which is what
    // lets the next frame ask again.
    expect(stickStep(1, 2, 0.7, 16)).toEqual({ armed: 1, repeats: 2, fire: 0 });
  });

  it("takes the same threshold the direction test does", () => {
    expect(stickStep(0, 0, 0.3, 0, 0.2)).toEqual({ armed: 1, repeats: 0, fire: 1 });
    expect(stickStep(0, 0, 0.1, 0, 0.2)).toEqual({ armed: 0, repeats: 0, fire: 0 });
  });
});
