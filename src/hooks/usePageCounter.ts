import { useCallback, useMemo, useRef, useState } from "react";

import {
  bookPageOf,
  bookPagesOf,
  emptyTally,
  globalProgress,
  observeUnit,
  totalChars,
} from "@/features/reader/progress";
import type { PageNumberScope } from "@/stores/reader";
import type { ChapterMeta } from "@/types/ipc";

/**
 * The page indicator, and the tally its whole-book unit is built from.
 *
 * Two halves of one measurement, and they belong together: `count` folds every
 * page count the layout took into a per-chapter tally, and `shown` prints
 * whichever unit the reader asked for — the `book` unit exists *because* of
 * that tally. Split them and the reader has to keep the ref alive for the
 * printer's sake.
 *
 * The tally is deliberately a ref rather than state: it is written on every
 * scroll and read only when a count lands, so holding it in state would
 * re-render the chapter for a measurement nobody is looking at yet. What it
 * produces (`bookPages`) *is* state, because the indicator prints it.
 *
 * `off` is decided here rather than by a second flag at the render site: the
 * two on-modes share every measurement below, so a separate gate would have to
 * be kept in step with this one — and the first version of that pairing showed
 * a chapter counter while the setting said 隐藏.
 */

/** A unit's counter as it is printed: where the reader is, and how long. */
export interface PageSize {
  page: number;
  pages: number;
}

/** A counter, tagged with whether it is a measurement or a whole-book estimate. */
export interface ShownPages extends PageSize {
  estimated: boolean;
}

export interface PageCounterOptions {
  /** Which unit the reader asked for. */
  unit: PageNumberScope;
  /** A format whose chapters *are* their pages (PDF, CBZ): the count is exact
   *  already, and estimating it only adds error — an image-only page carries no
   *  text to weigh, so every page of one printed the unit's own "1 / 1". */
  chapterIsPage: boolean;
  /** The Kindle path numbers positions off the book's own bytes. */
  useFoliate: boolean;
  chapters: ChapterMeta[];
  /** The chapter on screen, and how far into it. */
  chapterIdx: number;
  fraction: number;
  /** The unit's own counter, as the layout measured it. */
  pageInfo: PageSize | null;
  /** foliate's section counter, and its whole-book counter — the latter `null`
   *  until foliate has built its table. */
  foliatePage: PageSize | null;
  foliateBookPage: PageSize | null;
  /** Every setting a page count depends on. A change re-paginates the chapter,
   *  so the pages already in the tally belong to a layout that is gone. */
  densityKey: string;
  /**
   * The reader's own readiness test, handed in rather than derived here.
   *
   * It has always been `chapterData === null` — not `== null` — and a page
   * count is dropped on that answer. That is a narrower test than "the chapter
   * body is not on screen": `useChapter`'s data is `undefined` until its first
   * fetch settles, and an `undefined` chapter passes it. Tightening it here
   * would quietly change which measurements get filed, which is a real question
   * but not this hook's to answer.
   */
  chapterMissing: boolean;
}

export interface PageCounterControls {
  /** The counter to print, or `null` to print nothing at all. */
  shown: ShownPages | null;
  /** Folds one measured chapter page count into the book's tally. */
  count: (pages: number) => void;
}

export function usePageCounter({
  unit: scope,
  chapterIsPage,
  useFoliate,
  chapters,
  chapterIdx,
  fraction,
  pageInfo,
  foliatePage,
  foliateBookPage,
  densityKey,
  chapterMissing,
}: PageCounterOptions): PageCounterControls {
  const tallyRef = useRef(emptyTally());
  /** The layout the tally was measured under; a change invalidates it. */
  const densityKeyRef = useRef("");
  /** The book's page count at that tally, or `null` while it is too thin. */
  const [bookPages, setBookPages] = useState<number | null>(null);

  /**
   * The page counter to print, in whichever unit the reader asked for — or
   * `null` to print nothing at all.
   *
   * `chapter` is what the layout measured. `book` is the book's own length,
   * worked out two different ways because the two paths can measure different
   * things: foliate numbers positions off the book's bytes (`location`), so its
   * count is fixed for the book and both numbers come straight from it; the
   * prose pager has no such scale, so its count is what it has measured plus
   * what the rest of the book weighs at that density (`bookPagesOf`) — an
   * estimate, and the only case the indicator labels as one.
   */
  const shown = useMemo<ShownPages | null>(() => {
    if (scope === "off") return null;
    if (chapterIsPage) return { page: chapterIdx + 1, pages: chapters.length, estimated: false };

    const unit = useFoliate ? foliatePage : pageInfo;
    if (unit === null) return null;
    if (scope !== "book") return { ...unit, estimated: false };

    // foliate counts the book itself. Not an estimate: the size domain is a
    // property of the book's bytes, so it reads the same on every turn and at
    // every font size. Until its table exists, the section's own counter —
    // true, but not the book — stands in.
    if (useFoliate) {
      return foliateBookPage
        ? { ...foliateBookPage, estimated: false }
        : { ...unit, estimated: false };
    }

    // The prose pager's unit is a chapter, and its share of the book is by
    // character count — so `bookPages` is the book, and `globalProgress` is how
    // far into it the reader is, page inside the chapter included. A book with
    // no chapter text has no share to weigh and keeps the unit's counter.
    const chars = totalChars(chapters);
    if (bookPages === null || chars <= 0 || (chapters[chapterIdx]?.chars ?? 0) <= 0) {
      return { ...unit, estimated: false };
    }
    return {
      ...bookPageOf(globalProgress(chapters, chapterIdx, fraction), bookPages),
      estimated: true,
    };
  }, [
    scope,
    chapterIsPage,
    useFoliate,
    foliatePage,
    foliateBookPage,
    pageInfo,
    bookPages,
    chapters,
    chapterIdx,
    fraction,
  ]);

  /**
   * Folds one chapter's measured page count into the book's tally.
   *
   * Safe to call from every scroll: the chapter replaces its own entry, and the
   * first call after a layout change starts the tally over instead of mixing in
   * pages measured under the old one.
   *
   * Silent until the chapter body is on screen. `useChapter` fetches whenever
   * the index changes, so for a frame or two the scroller still holds the
   * chapter that just left — and a page count read off it, filed under the
   * chapter arriving, is that chapter's page count with the wrong name.
   */
  const count = useCallback(
    (pages: number) => {
      if (chapterMissing) return;
      if (densityKeyRef.current !== densityKey) {
        densityKeyRef.current = densityKey;
        tallyRef.current = emptyTally();
      }
      observeUnit(tallyRef.current, chapterIdx, pages);
      setBookPages(bookPagesOf(tallyRef.current, chapters));
    },
    [chapterMissing, chapterIdx, chapters, densityKey],
  );

  return { shown, count };
}
