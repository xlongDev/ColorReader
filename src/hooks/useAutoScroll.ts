import { useCallback, useEffect, useState, type RefObject } from "react";

import type { FoliateHandle } from "@/features/reader/FoliateBookView";
import type { LayoutMode } from "@/features/reader/theme";
import { foldScrollDelta } from "@/stores/reader";

/**
 * Auto-scroll: the reader's flag, and the loop that walks the flow while it is
 * set.
 *
 * The flag lives here rather than with the other reading settings because it
 * has three users and this hook is the only one that can also *clear* it: the
 * loop clears it when the flow runs out, the footer toggles it, and navigation
 * clears it on a chapter jump (a jump moves the viewport itself, and a loop
 * still walking the old offset would fight it). `stop` is what the other two
 * call, which is also why it has to keep one identity — see below.
 *
 * The loop is a `requestAnimationFrame` walk rather than a scroll animation, so
 * it must notice the things that invalidate it *between* frames: a layout that
 * is no longer scrollable, a foliate view that has gone, the end of the flow.
 * Each of those clears the flag instead of just returning, so the footer's
 * button agrees with what is happening.
 *
 * Two things about the effect's dependency list are load-bearing:
 *
 * - `layoutModeRef` is a ref on purpose. Reading the mode per frame is what
 *   lets the loop stop when the reader switches layout mid-run; closing over
 *   the mode would instead restart the loop on every switch, and the frame
 *   that arrived after the switch would scroll a viewport that is gone.
 * - `stop` is a stable `useCallback`, because it goes into `goTo`'s dependency
 *   list at the call site. A fresh identity there would rebuild the reader's
 *   chapter jump, which the position effect hangs off — the same trap the
 *   sleep timer and the read-aloud roll-over both document.
 */

export interface AutoScrollOptions {
  /** Whether the layout is paged. A paged layout has no flow to roll, so the
   *  flag is inert there and resumes when the reader comes back — the footer's
   *  button is disabled in that layout, so nobody can start it from there. */
  paged: boolean;
  /** Pixels per second. */
  speed: number;
  /** Which renderer is on screen: foliate owns its own scrollport. */
  useFoliate: boolean;
  layoutModeRef: RefObject<LayoutMode>;
  foliateRef: RefObject<FoliateHandle | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export interface AutoScrollControls {
  /** The flag as the flow sees it: set, and in a layout that can roll. */
  on: boolean;
  toggle: () => void;
  /** Clears it — the footer's off, the flow's end, and navigation's jump. */
  stop: () => void;
}

export function useAutoScroll({
  paged,
  speed,
  useFoliate,
  layoutModeRef,
  foliateRef,
  scrollRef,
}: AutoScrollOptions): AutoScrollControls {
  const [scrolling, setScrolling] = useState(false);
  const on = scrolling && !paged;

  const stop = useCallback(() => setScrolling(false), []);
  const toggle = useCallback(() => setScrolling((current) => !current), []);

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      if (layoutModeRef.current !== "scroll") {
        stop();
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      if (useFoliate) {
        // foliate owns the scrollport; the sub-pixel remainder rides its
        // composited transform so slow speeds still creep forward.
        const fold = foldScrollDelta(speed, dt, carry);
        carry = fold.carry;
        const handle = foliateRef.current;
        if (!handle) {
          stop();
          return;
        }
        if (fold.delta !== 0) handle.scrollByPx(fold.delta, fold.carry);
        if (handle.bookEnd()) {
          stop();
          return;
        }
        raf = requestAnimationFrame(step);
        return;
      }
      const el = scrollRef.current;
      if (!el) {
        stop();
        return;
      }
      // The fractional step, not the whole pixel it folds to. Truncating to
      // 1 px is what made 慢 stutter: at 20 px/s a frame advances a third of
      // a pixel, so the folded version moves once every third frame — 27
      // one-pixel hops a second instead of a glide. The engine snaps the
      // offset to *device* pixels, which is half a CSS pixel on a 2× screen,
      // and a sub-pixel assignment still lands there from every frame.
      el.scrollTop += speed * dt;
      const max = el.scrollHeight - el.clientHeight;
      if (el.scrollTop >= max - 1) {
        stop();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, speed, useFoliate, layoutModeRef, foliateRef, scrollRef, stop]);

  return { on, toggle, stop };
}
