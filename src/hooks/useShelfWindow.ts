import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

import {
  SECTION_HEADER_H,
  shelfItems,
  type BookSection,
  type ShelfItem,
} from "@/features/library/group";
import { useBookHandoff } from "@/stores/book-handoff";

/**
 * Which lines of the shelf actually render.
 *
 * A 500-book shelf mounted all 500 tiles — 500 motion trees, 500 covers, 500
 * layout projections — and the shelf's cost is linear in that number (measured
 * on a filter change: ≈2.75ms of main-thread work per book, ≈1.5ms on a mount,
 * at 4× CPU throttle). Nothing about the page needs the other 476: the scroller
 * is 614px tall and shows twelve cards.
 *
 * So the grid renders the lines the viewport can reach, plus `OVERSCAN_ROWS`
 * either side, and holds the rest of the list open with two spacers of exactly
 * the height it would have had anyway. Slicing by *whole lines* — never
 * mid-row — leaves the CSS grid in charge of the columns: no absolute
 * positioning, no transforms, and the responsive breakpoints stay where they
 * are declared.
 *
 * A line is a section heading or a row of cards (`ShelfItem`), and that is what
 * separates this from the plain division it started as: two kinds of line mean
 * two heights, so there is no longer a single pitch to multiply a row number
 * by. Positions come from a running offset over the items — cheap, exact, and
 * computed from the list rather than read back out of the DOM. The row pitch is
 * still measured (a card's height follows the column width, which follows the
 * pane), but it is now the only measurement left in here.
 */

/** Lines rendered beyond the viewport, on each side. */
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
  /** The lines to draw, and which of them to draw. */
  items: ShelfItem[];
  /** First line rendered, and one past the last. */
  start: number;
  end: number;
  /** Room held open above and below them, in px. */
  top: number;
  bottom: number;
  /**
   * How many tracks the grid should have at the pane width it now has.
   *
   * This is the one field here that is *written back*, not merely compared:
   * the caller pins it onto the grid as an inline `grid-template-columns`.
   * That is deliberate, and it is the whole reason the field exists.
   *
   * The grid used to let CSS decide — `repeat(auto-fill, minmax(0, …))` — and
   * that made a column change a *stylesheet* reflow: the browser re-laid the
   * tracks out the instant the pane grew, with no DOM mutation and no React
   * involvement. Motion's FLIP cannot see one. It snapshots in
   * `getSnapshotBeforeUpdate` (`MeasureLayout` in framer-motion) — i.e.
   * *before* React mutates the DOM — and compares that with a measurement
   * taken after the mutation; a move the DOM never performed is already in
   * the "before" box, so the delta is zero and nothing animates. Measured on
   * a 24-book shelf: the re-render fired exactly as intended at the frame the
   * grid went 4 → 5 columns, and every card's `transform` stayed `none` while
   * a tile crossed 170px in a single frame.
   *
   * With the count pinned, the tracks no longer follow the pane on their own.
   * The browser reflows nothing, this hook measures the new width, the count
   * changes, React writes the new track list, and *that* is the mutation
   * motion snapshots around — so the cards glide to their new slots the same
   * way they do on a filter or a sort. It also keeps the field in the
   * equality check below, where a column change that leaves `start`/`end`/
   * `top`/`bottom` alone (a one-row shelf, or any change that only moves
   * cards between columns) would otherwise be skipped as "nothing changed".
   *
   * One thing this does *not* animate, on purpose: dragging the window wider.
   * Motion blocks every layout animation while `window.innerWidth` is
   * changing (`updateBlockedByResize`, cleared 250ms after the last resize) so
   * a window drag cannot start a FLIP storm across the tree. The sidebar
   * moving does not change the window, so it is not blocked — which is the
   * whole of the difference between the two gestures.
   *
   * It also decides where every row break falls, so the item list is only ever
   * as good as this number: it is read before the items are cut.
   */
  columns: number;
}

/** The last item that starts at or before `offset`. */
function itemAt(off: number[], offset: number): number {
  let low = 0;
  let high = off.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((off[mid] ?? 0) <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // `off` has one more entry than there are items; the last of them is the
  // list's own height and never an item.
  return Math.min(found, off.length - 2);
}

/**
 * Whether two item lists describe the same shelf.
 *
 * Compared line by line rather than by reference: the list is rebuilt on every
 * read — it has to be, since it is cut by a column count that is measured — so
 * a reference check would report a change on every scrolling frame and
 * re-render the shelf under the reader's hand.
 *
 * Sections are compared by reference, which is sound because they come from the
 * caller's own memo: an unchanged shelf hands back the same objects.
 */
function sameItems(a: ShelfItem[], b: ShelfItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const next = a[i];
    const now = b[i];
    if (next === undefined || now === undefined || next.kind !== now.kind) return false;
    if (next.kind === "row" && now.kind === "row") {
      if (next.from !== now.from || next.to !== now.to) return false;
    } else if (next.kind === "header" && now.kind === "header" && next.section !== now.section) {
      return false;
    }
  }
  return true;
}

/**
 * @param sections the piles the shelf is in, in card order and with the index
 * each one starts at; empty when the shelf is not grouped.
 * @param total how many books the current view has.
 * @param collapsed the piles whose cards are folded away.
 * @param contentKey what the list *is* — filter, sort, search, label, grouping.
 * A change means the tiles arriving from here on are the shelf showing something
 * else, and should animate in; a change of window is scrolling, and should not.
 * Note that folding a pile is *not* in the key: the shelf is showing the same
 * books either way, so nothing should replay its entrance.
 * @param initialScroll where the shelf is about to be scrolled to, from the
 * place the caller remembers. The first frame has no geometry to derive a window
 * from, and a scroller whose content is too short **clamps** the scroll being
 * restored — which loses the reader's place and takes the tile a cover is flying
 * home to out of the DOM. So the first frame holds enough room open for that
 * scroll to be settable at all; the window replaces it in the same commit,
 * before anything is painted.
 * @param layout the grid's shape, because the column count is derived here and
 * the caller pins it back (see `ShelfWindow.columns`). `list` is one column
 * whatever the pane is doing.
 */
export function useShelfWindow(
  scrollerRef: RefObject<HTMLElement | null>,
  gridRef: RefObject<HTMLElement | null>,
  sections: BookSection[],
  total: number,
  collapsed: ReadonlySet<string>,
  contentKey: string,
  initialScroll: number,
  layout: "grid" | "list",
) {
  const [range, setRange] = useState<ShelfWindow>(() => ({
    // Cut at one column: nothing has been measured yet, and one column is the
    // arrangement that puts the most cards in the probe's two lines — which is
    // the only thing the first frame is for.
    items: shelfItems(sections, total, 1, collapsed),
    start: 0,
    end: 2,
    top: 0,
    bottom: initialScroll + FALLBACK_VIEWPORT,
    columns: 0,
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
    const style = getComputedStyle(grid);
    const columnGap = Number.parseFloat(style.columnGap) || 0;
    // The track as the stylesheet *declares* it, not as the grid resolved it.
    // `minmax(0, …)` lets a track shrink below the token whenever the tracks do
    // not fit, and a shrunken track feeds straight back into this arithmetic:
    // a grid pinned to one column too many would then ask for exactly that
    // many again, for ever. Measured on a 530px pane, 4 tracks resolved to
    // 117.5px each, `(530 + 20) / (117.5 + 20)` floored to 4, and the shelf
    // never came back from a narrow window — the pin only ever grew. The token
    // is the number the tracks are meant to be, so it is the number to divide
    // by, and it is read rather than repeated here so there is one of it.
    const track = Number.parseFloat(style.getPropertyValue("--shelf-track")) || 0;
    if (!(track > 0)) return null;
    // The grid is a block-level box, so this is the room its tracks have — and
    // it is a read of the *pane*, not of the tracks, which is why pinning the
    // count cannot feed back into it. This is `auto-fill`'s own arithmetic,
    // done here so the result can be handed back to React.
    const available = grid.getBoundingClientRect().width;
    const columns =
      layout === "list"
        ? 1
        : Math.max(1, Math.floor((available + columnGap) / (track + columnGap)));
    const gap = Number.parseFloat(style.rowGap) || 0;
    // The first *card*, not the first child: a heading may be the first thing in
    // the grid now, and a heading is not what a row pitch is made of.
    // `offsetHeight`, not a rectangle: a card is scaled while it enters, and a
    // rectangle would report the scaled height as the row pitch.
    let card: HTMLElement | null = null;
    for (const child of grid.children) {
      if (!child.hasAttribute("data-shelf-header")) {
        card = child as HTMLElement;
        break;
      }
    }
    const pitch = card ? card.offsetHeight + gap : FALLBACK_PITCH;
    if (!(pitch > 0)) return null;

    const items = shelfItems(sections, total, columns, collapsed);
    if (items.length === 0) {
      return { items, start: 0, end: 0, top: 0, bottom: 0, columns };
    }
    // `off[i]` is where line `i` begins, and the one extra entry is the end of
    // the list. A row's step is the pitch, which already carries the gap below
    // it; a heading is the one line whose height arrives *without* a gap, so it
    // takes one — the grid puts a gap after it exactly as it does between two
    // rows of cards. Counting that gap twice for rows is not a rounding error:
    // measured over 84 lines it put the list 2 KB taller than it draws, which
    // clamped every scroll to the bottom short of the end.
    const off: number[] = [0];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const step = item?.kind === "header" ? SECTION_HEADER_H + gap : pitch;
      off.push((off[i] ?? 0) + step);
    }
    const height = off[items.length] ?? 0;

    // Where the list's first line sits in the scroller's own content. Taken
    // back out of the DOM rather than compounded from the last read — the
    // spacer that is in there right now is subtracted — so a line measured a
    // frame late, or a tile leaving a frame late, cannot make it drift.
    const listTop =
      grid.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      shown.current.top;
    const at = scroller.scrollTop - listTop;
    const slack = OVERSCAN_ROWS * pitch;
    const viewport = scroller.clientHeight || FALLBACK_VIEWPORT;
    const start = itemAt(off, Math.max(0, at - slack));
    let end = start;
    while (end < items.length && (off[end] ?? 0) < at + viewport + slack) end += 1;
    if (end <= start) end = Math.min(items.length, start + 1);
    return {
      items,
      start,
      end,
      top: off[start] ?? 0,
      bottom: height - (off[end] ?? 0),
      columns,
    };
  }, [scrollerRef, gridRef, sections, total, collapsed, layout]);

  const sync = useCallback(() => {
    const next = read();
    if (next === null) return;
    const now = shown.current;
    if (
      next.start === now.start &&
      next.end === now.end &&
      next.top === now.top &&
      next.bottom === now.bottom &&
      next.columns === now.columns &&
      // Folding a pile changes the lines without necessarily moving the window
      // into them — measured, `start` and `end` both stay put when a pile is
      // folded out from under the fold.
      sameItems(next.items, now.items)
    ) {
      return;
    }
    shown.current = next;
    setRange(next);
  }, [read]);

  /**
   * Before paint, so the first frame a reader sees already has the window and
   * the height the geometry implies, and not the two-line probe that stood in
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
    // Two things to watch: the scroller, whose width is what the grid's tracks
    // are derived from, and the grid, whose height changes when the window does
    // — which is also the signal that there is a card to measure at last (the
    // window can only be read once something is rendered). Reading is cheap and
    // the state update is skipped when nothing changed, which is what keeps
    // this from looping on its own re-render. This effect is rebuilt when the
    // list or its shape changes, which is the only way the grid can come, go or
    // change height.
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

  return {
    items: range.items,
    start: range.start,
    end: range.end,
    top: range.top,
    bottom: range.bottom,
    columns: range.columns,
    sliding,
  };
}
