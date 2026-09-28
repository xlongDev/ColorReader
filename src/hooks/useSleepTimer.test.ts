import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSleepTimer } from "@/hooks/useSleepTimer";

/**
 * The sleep timer had no test of any kind before this file — no unit test, and
 * no e2e spec so much as mentions 睡眠/定时/sleep. It is small enough to pin
 * completely here, which is cheaper than leaving the one behaviour that stops
 * the voice on a reader's behalf to a full-suite run that never looked at it.
 */
describe("useSleepTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with nothing armed", () => {
    const { result } = renderHook(() => useSleepTimer(() => {}));
    expect(result.current.sleep).toBeNull();
  });

  it("stops the voice when the minutes run out, and clears itself", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const { result } = renderHook(() => useSleepTimer(onFire));

    act(() => result.current.choose(15));
    expect(result.current.sleep).toMatchObject({ kind: "minutes", minutes: 15 });

    // The deadline is the whole point: the card draws the countdown from it,
    // so nothing ticks in between.
    act(() => void vi.advanceTimersByTime(14 * 60_000));
    expect(onFire).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(60_000));
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(result.current.sleep).toBeNull();
  });

  it("a chapter timer arms no timeout at all", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const { result } = renderHook(() => useSleepTimer(onFire));

    act(() => result.current.choose("chapter"));
    act(() => void vi.advanceTimersByTime(60 * 60_000));

    expect(onFire).not.toHaveBeenCalled();
    expect(result.current.sleep).toEqual({ kind: "chapter" });
  });

  it("a chapter timer is spent by the end of a chapter, and says so", () => {
    const { result } = renderHook(() => useSleepTimer(() => {}));
    act(() => result.current.choose("chapter"));

    let claimed = false;
    act(() => {
      claimed = result.current.clearIfChapterEnded();
    });
    expect(claimed).toBe(true);
    expect(result.current.sleep).toBeNull();

    // Spent once: the next chapter end is not this timer's business, and the
    // caller must not stop the voice for it.
    act(() => {
      claimed = result.current.clearIfChapterEnded();
    });
    expect(claimed).toBe(false);
  });

  it("a minutes timer is not claimed by a chapter ending", () => {
    const { result } = renderHook(() => useSleepTimer(() => {}));
    act(() => result.current.choose(30));

    let claimed = true;
    act(() => {
      claimed = result.current.clearIfChapterEnded();
    });
    expect(claimed).toBe(false);
    expect(result.current.sleep).toMatchObject({ kind: "minutes" });
  });

  it("off clears whatever was armed", () => {
    const { result } = renderHook(() => useSleepTimer(() => {}));
    act(() => result.current.choose("chapter"));
    act(() => result.current.choose("off"));
    expect(result.current.sleep).toBeNull();
  });

  /**
   * The reason the ref exists. `onChapterEnd` is a dependency of the reader's
   * position effect, and a fresh identity there re-applies the pending scroll —
   * which yanks the page back to the top of the chapter the moment a timer is
   * armed. So both callbacks have to survive a re-render unchanged.
   */
  it("keeps both callbacks identity-stable across renders", () => {
    const { result, rerender } = renderHook(() => useSleepTimer(() => {}));
    const first = { choose: result.current.choose, clear: result.current.clearIfChapterEnded };

    rerender();

    expect(result.current.choose).toBe(first.choose);
    expect(result.current.clearIfChapterEnded).toBe(first.clear);
  });
});
