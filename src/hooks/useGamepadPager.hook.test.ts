import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPEAT_DELAY, REPEAT_INTERVAL, useGamepadPager } from "@/hooks/useGamepadPager";

/**
 * The poll loop, driven by hand.
 *
 * This file exists because the repeat cadence was wrong in a way no browser test
 * could see. The bug: the hold's clock was re-stamped **every frame**, so the
 * time since it last spoke was always one frame — about 16ms — and the repeat
 * delay was never reached. A stick held down then moved one block, ever, while
 * the d-pad beside it walked eight. The e2e suite did not catch it either, and
 * the reason is the useful part: **it depends on the frame rate**. Under a
 * throttled rAF the per-frame gap is large enough to clear the delay by accident,
 * so the broken build answered a 1.6s hold with 4 steps and passed a `> 2`
 * assertion, while at 60fps it would answer with 1 and fail.
 *
 * So the clock is stubbed and the frames are run explicitly, which makes the
 * cadence the only thing that decides the answer.
 */
let frames: FrameRequestCallback[] = [];
let clock = 0;

beforeEach(() => {
  frames = [];
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs every frame queued so far, 16.7ms later — one 60fps frame. */
function frame(now = clock + 16.7) {
  const queued = frames;
  frames = [];
  clock = now;
  act(() => {
    for (const callback of queued) callback(now);
  });
}

/** 60fps for `ms` — the frames a real browser would have shown. */
function framesFor(ms: number) {
  // `clock` moves inside `frame`, so the end is pinned before the walk starts.
  const until = clock + ms;
  for (let at = clock + 16.7; at <= until; at += 16.7) frame(at);
}

const pad = (pressed: boolean) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 });

let padState: { buttons: ReturnType<typeof pad>[]; axes: number[] };

function attachPad() {
  padState = { buttons: Array.from({ length: 17 }, () => pad(false)), axes: [0, 0, 0, 0] };
  vi.stubGlobal("navigator", {
    ...navigator,
    getGamepads: () => [{ index: 0, connected: true, ...padState }],
  });
}

/**
 * Changes what the pad reports and lets the loop read it. The hook polls, so a
 * press is not "handed over" until the next frame — asserting straight after
 * `act` asks a question about the wrong instant.
 */
function report(change: () => void) {
  act(change);
  frame();
}

function setup() {
  const onNext = vi.fn();
  const onPrev = vi.fn();
  const onLineForward = vi.fn();
  const onLineBack = vi.fn();
  const view = renderHook(() =>
    useGamepadPager({ enabled: true, onNext, onPrev, onLineForward, onLineBack }),
  );
  // The hook reads the initial pad state on mount; one frame gets it going.
  frame();
  return { view, onNext, onPrev, onLineForward, onLineBack };
}

describe("useGamepadPager", () => {
  it("does nothing while no pad is attached", () => {
    vi.stubGlobal("navigator", { ...navigator, getGamepads: () => [] });
    const onNext = vi.fn();
    renderHook(() => useGamepadPager({ enabled: true, onNext, onPrev: vi.fn() }));
    framesFor(500);
    expect(onNext).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it("answers a shoulder button, and keeps answering while it is held", () => {
    attachPad();
    const { onNext } = setup();

    report(() => {
      padState.buttons[5] = pad(true);
    });
    expect(onNext).toHaveBeenCalledTimes(1);
    framesFor(REPEAT_DELAY - 50);
    // Quiet for the delay — a press is a press, not a burst.
    expect(onNext).toHaveBeenCalledTimes(1);
    framesFor(REPEAT_INTERVAL * 4);
    expect(onNext.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  describe("holding to repeat", () => {
    it("walks the reading axis while the d-pad is held down", () => {
      attachPad();
      const { onLineForward } = setup();

      report(() => {
        padState.buttons[13] = pad(true);
      });
      // One press on the frame it goes down…
      expect(onLineForward).toHaveBeenCalledTimes(1);
      // …then quiet for the delay…
      framesFor(REPEAT_DELAY - 50);
      expect(onLineForward).toHaveBeenCalledTimes(1);
      // …and then it walks.
      framesFor(REPEAT_INTERVAL * 4);
      expect(onLineForward.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("walks the reading axis while the stick is held over", () => {
      // 🔴 The one that was broken. A stick reports a *position*, so its hold has
      // no button to edge-detect on and the clock is all that distinguishes "held
      // for one step" from "held and counting" — re-stamping it every frame pins
      // that gap at one frame and the stick never repeats, while the d-pad on the
      // same pad does. Measured at 60fps: 1.6s of holding gave the d-pad ten
      // steps and the stick one.
      attachPad();
      const { onLineForward } = setup();

      report(() => {
        padState.axes[1] = 1;
      });
      expect(onLineForward).toHaveBeenCalledTimes(1);
      framesFor(REPEAT_DELAY - 50);
      expect(onLineForward, "摇杆按住不动就该连续走，而不是停在第一步").toHaveBeenCalledTimes(1);
      framesFor(REPEAT_INTERVAL * 4);
      expect(onLineForward.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("stops the moment the input is released", () => {
      attachPad();
      const { onLineForward } = setup();

      report(() => {
        padState.axes[1] = 1;
      });
      framesFor(1000);
      const walked = onLineForward.mock.calls.length;

      act(() => {
        padState.axes[1] = 0;
      });
      framesFor(1000);
      expect(onLineForward.mock.calls.length, "松手之后还在走").toBe(walked);
    });

    it("counts a held stick from the moment it was pushed, not from mount", () => {
      attachPad();
      const { onLineForward } = setup();

      // Long idle first: the hold's clock must not be able to bank time while
      // nothing is held, or the first push would repeat instantly.
      framesFor(3000);
      report(() => {
        padState.axes[1] = 1;
      });
      framesFor(REPEAT_DELAY - 50);
      expect(onLineForward).toHaveBeenCalledTimes(1);
    });

    it("walks the page from the horizontal stick, like the d-pad beside it", () => {
      // The same two-phase window as the vertical axis: quiet through the delay,
      // then walking. Measuring only the steady interval would ask for repeats
      // before the first one is due.
      attachPad();
      const { onNext } = setup();

      report(() => {
        padState.axes[0] = 1;
      });
      expect(onNext).toHaveBeenCalledTimes(1);
      framesFor(REPEAT_DELAY - 50);
      expect(onNext).toHaveBeenCalledTimes(1);
      framesFor(REPEAT_INTERVAL * 4);
      expect(onNext.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("does nothing at all when the reader has switched it off", () => {
    attachPad();
    const onNext = vi.fn();
    const onLineForward = vi.fn();
    renderHook(() =>
      useGamepadPager({
        enabled: false,
        onNext,
        onPrev: vi.fn(),
        onLineForward,
        onLineBack: vi.fn(),
      }),
    );
    act(() => {
      padState.buttons[5] = pad(true);
      padState.axes[1] = 1;
    });
    framesFor(1000);
    expect(onNext).not.toHaveBeenCalled();
    expect(onLineForward).not.toHaveBeenCalled();
  });

  it("leaves the face buttons to whatever else wants them", () => {
    // A pedal that reports A is indistinguishable from a pad somebody is
    // playing with — turning a page on that is worse than not at all.
    attachPad();
    const { onNext } = setup();
    act(() => {
      padState.buttons[0] = pad(true);
    });
    framesFor(500);
    expect(onNext).not.toHaveBeenCalled();
  });
});
