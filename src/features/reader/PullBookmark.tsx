import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { BookmarkSimple } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";

/** Raw drag distance that commits the bookmark. */
const THRESHOLD = 64;
/** Ceiling on the drawn pull, so a long drag does not sweep the pill away. */
const MAX_PULL = 88;
/** How much of the raw drag the pill travels; a finger moves further than the
 *  thing it drags, which is what makes a pull feel elastic rather than glued. */
const DAMPING = 0.55;

/**
 * Pull down at the top of the page to bookmark the spot.
 *
 * A borrowed gesture: it does what pull-to-refresh does, which is why it needs
 * no instruction — the reader already knows that dragging down from the top of
 * a list means something. What it means here is "remember this place", which is
 * the one thing a reader wants to do at a place and never remembers to do from
 * a toolbar.
 *
 * Three things keep it from fighting the page:
 *
 * - **It only arms at the top.** Anywhere else a downward drag is the reader
 *   scrolling back up the page, and hijacking that would make the whole page
 *   feel broken rather than adding a shortcut to it.
 * - **Touch only.** A downward *mouse* drag at the top of a page is a text
 *   selection starting; claiming it would cost the reader words, not gestures.
 * - **It gives the drag back when it is not a pull.** A drag that starts at the
 *   top and turns into a horizontal swipe is abandoned rather than held.
 *
 * It is not a refresh gesture, so it never blocks scrolling to get its way: no
 * `preventDefault`, no `touch-action` on the page. At the top of a scrolled
 * page there is nothing above to scroll to, so the drag is free.
 */
export function PullBookmark({
  hostRef,
  scrollRef,
  enabled,
  onTrigger,
}: {
  /** The reading viewport, where the pill is drawn. */
  hostRef: RefObject<HTMLElement | null>;
  /** The scrolling box, read to tell "at the top" from "scrolled". */
  scrollRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onTrigger: () => void;
}) {
  const [pull, setPull] = useState(0);
  const [done, setDone] = useState(false);
  // Gesture bookkeeping lives in a ref, not in state: it changes many times per
  // drag and none of it is drawn, so putting it in state would re-render the
  // reader on every pointermove.
  const drag = useRef<{ id: number; y: number } | null>(null);
  const doneTimer = useRef<number | undefined>(undefined);
  // The live pull, and the trigger, mirrored into refs: both are read by the
  // gesture's own handlers, and neither may be a dependency of the effect that
  // installs them — `pull` changes on every pointermove and `onTrigger` is a
  // fresh closure on every render, so either one in the dep list would tear the
  // listeners down and rebuild them mid-drag.
  const pullRef = useRef(0);
  const triggerRef = useRef(onTrigger);
  useEffect(() => {
    triggerRef.current = onTrigger;
  }, [onTrigger]);

  const atTop = useCallback(() => {
    const scroller = scrollRef.current;
    return !scroller || scroller.scrollTop <= 0;
  }, [scrollRef]);

  useEffect(() => {
    const host = hostRef.current;
    if (!enabled || !host) return;

    const track = (next: number) => {
      pullRef.current = next;
      setPull(next);
    };

    const finish = (commit: boolean) => {
      const armed = pullRef.current >= THRESHOLD * DAMPING;
      drag.current = null;
      track(0);
      if (!commit || !armed) return;
      triggerRef.current();
      setDone(true);
      window.clearTimeout(doneTimer.current);
      doneTimer.current = window.setTimeout(() => setDone(false), 1200);
    };

    const onDown = (event: PointerEvent) => {
      // A mouse drag is a selection; a pen is a stylus, which is a finger.
      if (event.pointerType === "mouse") return;
      if (!atTop()) return;
      drag.current = { id: event.pointerId, y: event.clientY };
    };

    const onMove = (event: PointerEvent) => {
      const start = drag.current;
      if (!start || start.id !== event.pointerId) return;
      const dy = event.clientY - start.y;
      // Upward, or a flick that never committed to the vertical: hand the drag
      // back to the page instead of holding it.
      if (dy <= 0) {
        drag.current = null;
        track(0);
        return;
      }
      track(Math.min(dy * DAMPING, MAX_PULL));
    };

    const onUp = (event: PointerEvent) => {
      if (drag.current?.id !== event.pointerId) return;
      finish(true);
    };

    host.addEventListener("pointerdown", onDown, { passive: true });
    host.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerup", onUp, { passive: true });
    host.addEventListener("pointercancel", onUp, { passive: true });
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      window.clearTimeout(doneTimer.current);
    };
  }, [hostRef, enabled, atTop]);

  if (!enabled) return null;

  // Crossing the threshold is the whole feedback: the pill changes its word,
  // so the reader knows before letting go whether letting go will do anything.
  const armed = pull >= THRESHOLD * DAMPING;
  const progress = Math.min(pull / (THRESHOLD * DAMPING), 1);

  return (
    <div
      aria-hidden
      data-pull-bookmark
      data-armed={armed || undefined}
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center"
      style={{ transform: `translateY(${-28 + pull}px)`, opacity: done ? 1 : progress }}
    >
      <span
        className={cn(
          "glass-solid shadow-panel flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px]",
          armed ? "text-accent" : "text-text-2",
        )}
      >
        <BookmarkSimple size={13} weight={done || armed ? "fill" : "regular"} />
        {done ? "书签已保存" : armed ? "松手添加书签" : "下拉添加书签"}
      </span>
    </div>
  );
}
