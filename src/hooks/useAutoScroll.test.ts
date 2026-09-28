import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoliateHandle } from "@/features/reader/FoliateBookView";
import type { LayoutMode } from "@/features/reader/theme";
import { useAutoScroll, type AutoScrollOptions } from "@/hooks/useAutoScroll";

/**
 * Auto-scroll had no test of any kind before this file — no unit test, and no
 * e2e spec mentions 自动滚动. What it is, is a `requestAnimationFrame` walk with
 * five ways to end, and each of those is a promise to the reader that the
 * footer's button agrees with: the flow ran out, the layout left scroll, the
 * viewport went away. So the frames are driven by hand here rather than left to
 * a timer, and the clock is stubbed so a step is exactly the pixels the speed
 * asks for.
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

/** Runs every frame queued so far at `now`, and lets React settle. */
function runFrames(now: number) {
  const queued = frames;
  frames = [];
  clock = now;
  act(() => {
    for (const callback of queued) callback(now);
  });
}

/** A scroller the loop can measure: it only ever reads these three numbers and
 *  writes the first. */
function fakeScroller(scrollTop = 0, scrollHeight = 1000, clientHeight = 100) {
  return { scrollTop, scrollHeight, clientHeight } as unknown as HTMLDivElement;
}

function setup(overrides: Partial<AutoScrollOptions> = {}) {
  const options: AutoScrollOptions = {
    paged: false,
    speed: 100,
    useFoliate: false,
    layoutModeRef: { current: "scroll" as LayoutMode },
    foliateRef: { current: null },
    scrollRef: { current: fakeScroller() },
    ...overrides,
  };
  return renderHook((props: AutoScrollOptions) => useAutoScroll(props), {
    initialProps: options,
  });
}

describe("useAutoScroll", () => {
  it("runs nothing until it is asked to", () => {
    const { result } = setup();
    expect(result.current.on).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("walks the scroller at the speed it was given", () => {
    const scroller = fakeScroller(0);
    const { result } = setup({ speed: 100, scrollRef: { current: scroller } });

    act(() => result.current.toggle());
    expect(result.current.on).toBe(true);

    // The effect queues the first frame; 100 ms of a 100 px/s walk is 10 px.
    runFrames(100);
    expect(scroller.scrollTop).toBe(10);
    expect(result.current.on).toBe(true);
    expect(frames).toHaveLength(1);

    // And it keeps walking, a frame at a time.
    runFrames(200);
    expect(scroller.scrollTop).toBe(20);
  });

  it("stops when the flow runs out", () => {
    const scroller = fakeScroller(899);
    const { result } = setup({ scrollRef: { current: scroller } });

    act(() => result.current.toggle());
    runFrames(16);

    expect(result.current.on).toBe(false);
    // Nothing further is queued: the footer's button agrees with the flow.
    expect(frames).toHaveLength(0);
  });

  it("stops when the layout leaves scroll", () => {
    const scroller = fakeScroller(0);
    const layoutModeRef = { current: "single" as LayoutMode };
    const { result } = setup({ layoutModeRef, scrollRef: { current: scroller } });

    act(() => result.current.toggle());
    runFrames(16);

    expect(result.current.on).toBe(false);
    expect(frames).toHaveLength(0);
    // Read per frame, so it noticed without a re-render — and it did not move
    // the page on its way out.
    expect(scroller.scrollTop).toBe(0);
  });

  it("stops when the viewport has gone", () => {
    const { result } = setup({ scrollRef: { current: null } });

    act(() => result.current.toggle());
    runFrames(16);

    expect(result.current.on).toBe(false);
    expect(frames).toHaveLength(0);
  });

  /**
   * A paged layout has no flow to roll, so the flag is inert there rather than
   * cleared: the reader who set it gets it back when they return to scroll.
   */
  it("holds the flag through a paged layout and resumes after it", () => {
    const { result, rerender } = setup({ paged: true });

    act(() => result.current.toggle());
    expect(result.current.on).toBe(false);
    expect(frames).toHaveLength(0);

    rerender({
      paged: false,
      speed: 100,
      useFoliate: false,
      layoutModeRef: { current: "scroll" as LayoutMode },
      foliateRef: { current: null },
      scrollRef: { current: fakeScroller() },
    });

    expect(result.current.on).toBe(true);
    expect(frames).toHaveLength(1);
  });

  it("hands a foliate book to its own scrollport, carrying the sub-pixel", () => {
    const scrollByPx = vi.fn();
    const handle = { scrollByPx, bookEnd: () => false } as unknown as FoliateHandle;
    const { result } = setup({
      useFoliate: true,
      speed: 20,
      foliateRef: { current: handle },
    });

    act(() => result.current.toggle());
    // 20 px/s over three 16.7 ms frames is 1.002 px: the loop must not move the
    // book on the first two, and must carry the remainder into the third.
    runFrames(16.7);
    runFrames(33.4);
    expect(scrollByPx).not.toHaveBeenCalled();

    runFrames(50.1);
    expect(scrollByPx).toHaveBeenCalledTimes(1);
    expect(scrollByPx.mock.calls[0]?.[0]).toBe(1);
  });

  it("stops at the end of a foliate book", () => {
    const handle = {
      scrollByPx: vi.fn(),
      bookEnd: () => true,
    } as unknown as FoliateHandle;
    const { result } = setup({ useFoliate: true, foliateRef: { current: handle } });

    act(() => result.current.toggle());
    runFrames(16);

    expect(result.current.on).toBe(false);
    expect(frames).toHaveLength(0);
  });

  /**
   * `stop` goes into `goTo`'s dependency list, and `goTo` is what the reader's
   * position effect hangs off: a fresh identity there re-applies the pending
   * scroll and snaps the page back to the top of the chapter.
   */
  it("keeps both actions identity-stable across renders", () => {
    const { result, rerender } = setup();
    const first = { toggle: result.current.toggle, stop: result.current.stop };

    rerender({
      paged: false,
      speed: 250,
      useFoliate: false,
      layoutModeRef: { current: "scroll" as LayoutMode },
      foliateRef: { current: null },
      scrollRef: { current: fakeScroller() },
    });

    expect(result.current.toggle).toBe(first.toggle);
    expect(result.current.stop).toBe(first.stop);
  });
});
