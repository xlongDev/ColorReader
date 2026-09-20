import { describe, expect, it } from "vitest";

import {
  bookPageFromLocation,
  bookPageOf,
  bookPagesOf,
  emptyTally,
  estimateLabel,
  globalProgress,
  locateChapter,
  observeUnit,
  remainingChars,
  totalChars,
} from "./progress";
import type { ChapterMeta } from "@/types/ipc";

const chapters: ChapterMeta[] = [
  { idx: 0, title: "甲", chars: 10 },
  { idx: 1, title: "乙", chars: 30 },
  { idx: 2, title: "丙", chars: 10 },
];

describe("totalChars", () => {
  it("sums chapter character counts", () => {
    expect(totalChars(chapters)).toBe(50);
    expect(totalChars([])).toBe(0);
  });
});

describe("locateChapter", () => {
  it("maps the very start to the first chapter", () => {
    expect(locateChapter(chapters, 0)).toEqual({ idx: 0, fraction: 0 });
  });

  it("falls at a chapter boundary on the next chapter", () => {
    // 10/50 = 0.2 is exactly the end of chapter 0.
    expect(locateChapter(chapters, 0.2)).toEqual({ idx: 1, fraction: 0 });
  });

  it("maps the middle onto the correct chapter and offset", () => {
    // 25/50 = 0.5 → 15 chars into chapter 1 (30 chars) = 0.5.
    expect(locateChapter(chapters, 0.5)).toEqual({ idx: 1, fraction: 0.5 });
  });

  it("clamps overshoot to the final chapter", () => {
    expect(locateChapter(chapters, 1)).toEqual({ idx: 2, fraction: 1 });
    expect(locateChapter(chapters, 1.5)).toEqual({ idx: 2, fraction: 1 });
  });

  it("handles an empty table gracefully", () => {
    expect(locateChapter([], 0.4)).toEqual({ idx: 0, fraction: 0 });
  });

  describe("a book with no text to weigh", () => {
    // A PDF whose extraction is still owed — or never succeeded. Chapter 0 for
    // every position would lose the saved place and freeze it there, because
    // `globalProgress` would answer 0 forever after.
    const owed: ChapterMeta[] = [0, 1, 2, 3].map((idx) => ({ idx, title: "", chars: 0 }));

    it("spreads the position across the chapters instead of collapsing it", () => {
      expect(locateChapter(owed, 0)).toEqual({ idx: 0, fraction: 0 });
      expect(locateChapter(owed, 0.5)).toEqual({ idx: 2, fraction: 0 });
      expect(locateChapter(owed, 0.99)).toEqual({ idx: 3, fraction: 0 });
      expect(locateChapter(owed, 1)).toEqual({ idx: 3, fraction: 0 });
    });

    it("still answers a progress the position can move by", () => {
      expect(globalProgress(owed, 0, 0)).toBe(0);
      expect(globalProgress(owed, 2, 0)).toBeCloseTo(0.5);
      expect(globalProgress(owed, 3, 1)).toBe(1);
    });
  });
});

describe("globalProgress", () => {
  it("is the inverse of locateChapter", () => {
    const located = locateChapter(chapters, 0.5);
    expect(globalProgress(chapters, located.idx, located.fraction)).toBeCloseTo(0.5);
  });

  it("reports 0 for the start and 1 for the end", () => {
    expect(globalProgress(chapters, 0, 0)).toBe(0);
    expect(globalProgress(chapters, 2, 1)).toBe(1);
  });
});

describe("remainingChars", () => {
  it("counts from the current position to the end of the book", () => {
    expect(remainingChars(chapters, 0, 0)).toBe(50);
    expect(remainingChars(chapters, 1, 0.5)).toBe(25);
    expect(remainingChars(chapters, 2, 1)).toBe(0);
  });

  it("never goes negative on an overshooting fraction", () => {
    expect(remainingChars(chapters, 2, 1.5)).toBe(0);
    expect(remainingChars([], 0, 0)).toBe(0);
  });
});

describe("estimateLabel", () => {
  it("labels sub-minute, minutes and hours", () => {
    expect(estimateLabel(100, 300)).toBe("不到 1 分钟");
    expect(estimateLabel(900, 300)).toBe("约 3 分钟");
    expect(estimateLabel(7200, 300)).toBe("约 24 分钟");
    expect(estimateLabel(36000, 300)).toBe("约 2 小时");
    expect(estimateLabel(37000, 300)).toBe("约 2 小时 3 分钟");
  });

  it("degrades gracefully on a zero speed", () => {
    expect(estimateLabel(100, 0)).toBe("未知");
  });
});

describe("bookPageOf", () => {
  it("maps a fraction onto the book's pages, counting from one", () => {
    expect(bookPageOf(0, 20)).toEqual({ page: 1, pages: 20 });
    expect(bookPageOf(0.5, 20)).toEqual({ page: 11, pages: 20 });
    expect(bookPageOf(1, 20)).toEqual({ page: 20, pages: 20 });
  });

  it("cannot report a page outside the book", () => {
    // A layout can hand over a fraction a hair past the end, or a negative one
    // on the first paint; "21 / 20 页" is a number disagreeing with itself.
    expect(bookPageOf(1.4, 20)).toEqual({ page: 20, pages: 20 });
    expect(bookPageOf(-0.2, 20)).toEqual({ page: 1, pages: 20 });
  });
});

/** Chapters of `chars` characters each, as the importer reports them. */
const chaptersOf = (...chars: number[]): ChapterMeta[] =>
  chars.map((c, idx) => ({ idx, title: "", chars: c }));

describe("bookPagesOf", () => {
  it("counts a measured chapter as measured and sizes the rest at that density", () => {
    // A chapter of 1000 characters paginated into 4 pages: 250 characters a
    // page, which is what the three chapters not yet read are sized with.
    const tally = emptyTally();
    observeUnit(tally, 0, 4);
    expect(bookPagesOf(tally, chaptersOf(1000, 1000, 1000))).toBe(12);

    // Reading the second one does not move the book: the layout counted the
    // same 4 pages the estimate had already given it.
    observeUnit(tally, 1, 4);
    expect(bookPagesOf(tally, chaptersOf(1000, 1000, 1000))).toBe(12);
  });

  it("does not let the chapter on screen set the book's density", () => {
    // The defect this replaces: the whole-book count came out of the chapter
    // under the cursor (`measured pages / measured share` of the book), so the
    // same EPUB reported 493, 977, 805, 2202 and 939 pages to one reader as it
    // was read. Here the count is a sum over chapters, so a chapter that is
    // long, short or in the middle of the book weighs exactly itself.
    const tally = emptyTally();
    const book = chaptersOf(1000, 1000, 1000, 40);
    observeUnit(tally, 0, 4);
    const first = bookPagesOf(tally, book);
    observeUnit(tally, 1, 4);
    observeUnit(tally, 2, 4);
    observeUnit(tally, 3, 1);
    expect(bookPagesOf(tally, book)).toBe(first);
    // 4 + 4 + 4 pages of the long chapters, and one page for the one-paragraph
    // chapter that is a hundredth of the book.
    expect(first).toBe(13);
  });

  it("sizes a short chapter down to a single page rather than to nothing", () => {
    const tally = emptyTally();
    observeUnit(tally, 0, 4);
    // 40 characters at 250 a page is a sixth of a page, and a sixth of a page
    // is still a page: a chapter cannot be smaller than the page it starts on.
    expect(bookPagesOf(tally, chaptersOf(1000, 40))).toBe(5);
  });

  it("keeps a one-page unit out of the density it reads", () => {
    // A cover, a plate, a divider — and every chapter that fits on one page,
    // where the break at the end is most of what the "page" is. Letting one of
    // those speak is how a 1-page chapter dragged the count off by a page.
    const tally = emptyTally();
    const book = chaptersOf(1000, 40);
    // Nothing long enough to be evidence yet: the caller keeps the chapter's
    // own counter instead of a number made up from one page.
    observeUnit(tally, 1, 1);
    expect(bookPagesOf(tally, book)).toBeNull();

    observeUnit(tally, 0, 4);
    expect(bookPagesOf(tally, book)).toBe(5);
    // Measuring the short chapter again does not move it.
    observeUnit(tally, 1, 1);
    expect(bookPagesOf(tally, book)).toBe(5);
  });

  it("stays quiet until a chapter carrying real text has been measured", () => {
    const tally = emptyTally();
    expect(bookPagesOf(tally, chaptersOf(1000, 1000))).toBeNull();
    observeUnit(tally, 0, 0);
    expect(bookPagesOf(tally, chaptersOf(1000, 1000))).toBeNull();
  });

  it("lets a chapter that is measured again replace its own entry", () => {
    // A re-layout re-paginates every chapter, and the chapter after a
    // roll-over is first measured with the previous chapter's pages still on
    // screen. Counting it twice would let one chapter outweigh the book.
    const tally = emptyTally();
    observeUnit(tally, 0, 9);
    observeUnit(tally, 0, 4);
    expect(bookPagesOf(tally, chaptersOf(1000, 1000))).toBe(8);
  });
});

describe("bookPageFromLocation", () => {
  it("prints foliate's counter one-based", () => {
    // foliate counts from zero; a reader counts pages from one.
    expect(bookPageFromLocation({ current: 11, next: 12, total: 467 })).toEqual({
      page: 12,
      pages: 467,
    });
  });

  it("cannot print a page past the end of the book", () => {
    // The last position is the total, and a turn past it must not read
    // "468 / 467 页" — a number disagreeing with itself.
    expect(bookPageFromLocation({ current: 467, next: 468, total: 467 })).toEqual({
      page: 467,
      pages: 467,
    });
    expect(bookPageFromLocation({ current: 0, next: 2, total: 1 })).toEqual({
      page: 1,
      pages: 1,
    });
  });

  it("has nothing to say before foliate builds its table", () => {
    // The caller falls back to the section's own counter, which is true but is
    // not the book — inventing a book length here is the bug being fixed.
    expect(bookPageFromLocation(undefined)).toBeNull();
    expect(bookPageFromLocation(null)).toBeNull();
    expect(bookPageFromLocation({ current: 0, next: 0, total: 0 })).toBeNull();
  });
});
