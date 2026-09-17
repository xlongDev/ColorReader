import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

import { useBookHandoff } from "@/stores/book-handoff";

/**
 * Which cards the shelf actually renders.
 *
 * A 500-book shelf mounted all 500 tiles — 500 motion trees, 500 covers, 500
 * layout projections — and the shelf's cost is linear in that number (measured
 * on a filter change: ≈2.75ms of main-thread work per book, ≈1.5ms on a mount,
 * at 4× CPU throttle). Nothing about the page needs the other 476: the scroller
 * is 614px tall and shows twelve cards.
 *
 * So the grid renders the rows the viewport can reach, plus `OVERSCAN_ROWS`
 * either side, and holds the rest of the list open with two spacers of exactly
 * the height it would have had anyway. Slicing by *whole rows* — never mid-row —
 * leaves the CSS grid in charge of the columns: no absolute positioning, no
 * transforms, and the responsive breakpoints stay where they are declared.
 */

/** Rows rendered beyond the viewport, on each side. */
const OVERSCAN_ROWS = 2;

/** A viewport to hold open before one has been measured. Only ever seen on the
 *  first frame of a mount, and never painted. */
const FALLBACK_VIEWPORT = 800;

/**
 * A row to assume while nothing is rendered to measure.
 *
 * The list starts empty (the books are still on their way in), which renders the
 * empty state and therefore no card — and then the shelves' own first window has
 * nothing to read a pitch from. Without this the window would be computed as
 * zero cards and stay there: no card means nothing to measure means no cards.
 * The value is the measured pitch of a six-column shelf; it is only ever used
 * for the frame that follows the books arriving, and the grid is re-read the
 * moment it has a card in it.
 */
const FALLBACK_PITCH = 280;

interface ShelfWindow {
  /** First card rendered, and one past the last. */
  start: number;
  end: number;
  /** Room held open above and below them, in px. */
  top: number;
  bottom: number;
}

/**
 * @param total how many books the current view has.
 * @param contentKey what the list *is* — filter, sort, search, label. A change
 * means the tiles arriving from here on are the shelf showing something else,
 * and should animate in; a change of window is scrolling, and should not.
 * @param initialScroll where the shelf is about to be scrolled to, from the
 * place the caller remembers. The first frame has no geometry to derive a window
 * from, and a scroller whose content is too short **clamps** the scroll being
 * restored — which loses the reader's place and takes the tile a cover is flying
 * home to out of the DOM. So the first frame holds enough room open for that
 * scroll to be settable at all; the window replaces it in the same commit,
 * before anything is painted.
 */
export function useShelfWindow(
  scrollerRef: RefObject<HTMLElement | null>,
  gridRef: RefObject<HTMLElement | null>,
  total: number,
  contentKey: string,
  initialScroll: number,
) {
  const [range, setRange] = useState<ShelfWindow>(() => ({
    start: 0,
    end: Math.min(1, total),
    top: 0,
    bottom: initialScroll + FALLBACK_VIEWPORT,
  }));
  const shown = useRef(range);
  const frame = useRef(0);
  const flying = useBookHandoff((s) => s.id !== null);
  const [sliding, setSliding] = useState(false);
  const [content, setContent] = useState(contentKey);

  /**
   * A different set of books: what mounts with it animates. Adjusted during the
   * render that sees the new key rather than in an effect, so the tiles that
   * arrive get the flag in the very pass they mount in.
   */
  if (content !== contentKey) {
    setContent(contentKey);
    setSliding(false);
  }

  /** The window this layout implies, or null before there is anything to read. */
  const read = useCallback((): ShelfWindow | null => {
    const scroller = scrollerRef.current;
    const grid = gridRef.current;
    if (!scroller || !grid) return null;
    const card = grid.firstElementChild as HTMLElement | null;
    const columns = getComputedStyle(grid).gridTemplateColumns;
    if (columns === "none") return null;
    const count = columns.split(" ").length;
    const gap = Number.parseFloat(getComputedStyle(grid).rowGap) || 0;
    // `offsetHeight`, not a rectangle: a card is scaled while it enters, and a
    // rectangle would report the scaled height as the row pitch. A lone card is
    // still as wide as its column, so one row is enough to measure with.
    const pitch = card ? card.offsetHeight + gap : FALLBACK_PITCH;
    if (!(count > 0) || !(pitch > 0)) return null;
    const totalRows = Math.ceil(total / count);
    // Anchored on the *first row of the list*: the grid sits below the rows the
    // window is holding open, so the spacer that is actually in the DOM is taken
    // back out of its position. What is left is a property of the page — how much
    // sits above the list's first row — so every read is derived from the DOM
    // rather than compounded from the last one, and a row measured a frame late
    // (or a tile leaving a frame late) cannot make it drift.
    const gridTop =
      grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const rowZero = gridTop - shown.current.top;
    const firstRow = Math.round((scroller.scrollTop - rowZero) / pitch);
    const onScreen = Math.max(1, Math.ceil(scroller.clientHeight / pitch));
    const startRow = Math.max(0, firstRow - OVERSCAN_ROWS);
    const endRow = Math.min(
      totalRows,
      Math.max(startRow + 1, firstRow + onScreen + OVERSCAN_ROWS + 1),
    );
    return {
      start: startRow * count,
      end: Math.min(total, endRow * count),
      top: startRow * pitch,
      bottom: (totalRows - endRow) * pitch,
    };
  }, [scrollerRef, gridRef, total]);

  const sync = useCallback(() => {
    const next = read();
    if (next === null) return;
    const now = shown.current;
    if (
      next.start === now.start &&
      next.end === now.end &&
      next.top === now.top &&
      next.bottom === now.bottom
    ) {
      return;
    }
    shown.current = next;
    setRange(next);
  }, [read]);

  /**
   * Before paint, so the first frame a reader sees already has the window and
   * the height the geometry implies, and not the single-card probe that stood in
   * for them. The caller must restore the shelf's scroll position in a layout
   * effect written *before* this hook is called: effects run in the order they
   * are written, and a window measured before that restore is the top of the
   * list — which is where a cover flying home would then find no tile.
   */
  useLayoutEffect(() => {
    sync();
  }, [sync]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        // A cover in the air is aimed at one tile, with the box it was handed
        // when it left, and the flight never asks again. Sliding the window out
        // from under that tile would unmount it and leave the cover landing on
        // an empty slot — so the window is frozen for the few hundred ms it is
        // in the air, and catches up when it is over.
        if (useBookHandoff.getState().id !== null) return;
        setSliding(true);
        // Flushed rather than scheduled: this runs between frames, and an update
        // React is free to defer lands *after* the next paint — the reader
        // scrolls into rows that are not there yet, and the window falls a
        // gesture behind for as long as they keep moving.
        flushSync(sync);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // Two things to watch: the scroller, whose width decides the columns, and the
    // grid, whose height changes when the window does — which is also the signal
    // that there is a card to measure at last (the window can only be read once
    // something is rendered). Reading is cheap and the state update is skipped
    // when nothing changed, which is what keeps this from looping on its own
    // re-render. This effect is rebuilt when `total` changes, which is the only
    // way the grid can come or go.
    const observer = new ResizeObserver(() => sync());
    observer.observe(scroller);
    if (gridRef.current) observer.observe(gridRef.current);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame.current);
      observer.disconnect();
    };
  }, [scrollerRef, gridRef, sync]);

  useEffect(() => {
    if (!flying) sync();
  }, [flying, sync]);

  return { start: range.start, end: range.end, top: range.top, bottom: range.bottom, sliding };
}
