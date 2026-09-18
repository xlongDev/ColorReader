import { describe, expect, it } from "vitest";

import {
  bookPageAt,
  estimateLabel,
  globalProgress,
  locateChapter,
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

describe("bookPageAt", () => {
  // A four-chapter book of equal chapters, five pages in each. The unit spans a
  // quarter of the book and holds five pages, so the book reads as 20 pages.
  const quarter = 0.25;

  it("counts the pages before the unit, then the page inside it", () => {
    // Third chapter, its third page: 10 pages before it, so page 13.
    expect(bookPageAt(quarter * 2, quarter, { page: 3, pages: 5 })).toEqual({
      page: 13,
      pages: 20,
    });
  });

  it("agrees with itself at both ends of the book", () => {
    expect(bookPageAt(0, quarter, { page: 1, pages: 5 })).toEqual({ page: 1, pages: 20 });
    expect(bookPageAt(quarter * 3, quarter, { page: 5, pages: 5 })).toEqual({
      page: 20,
      pages: 20,
    });
  });

  it("weighs an uneven unit by its own page density", () => {
    // A long chapter holding a third of the book in 12 pages: 36 pages of book.
    // 12 pages in, on page 2 of the next unit.
    expect(bookPageAt(1 / 3, 1 / 6, { page: 2, pages: 6 })).toEqual({ page: 14, pages: 36 });
  });

  it("takes the book's length from the unit's density, not from the unit", () => {
    // A one-page chapter that measures as a fortieth of the book says the book
    // is forty pages long, and says the reader is on page 1 of it.
    expect(bookPageAt(0, 1 / 40, { page: 1, pages: 1 })).toEqual({ page: 1, pages: 40 });
  });

  it("cannot contradict itself on a span that is not a share of the book", () => {
    // Well-formed input satisfies both bounds on its own, so these assertions
    // pin the guards rather than a live branch. A unit overlapping the book's
    // end would otherwise run 5 pages past it and print "28 / 25 页"…
    expect(bookPageAt(0.9, 0.2, { page: 5, pages: 5 })).toEqual({ page: 25, pages: 25 });
    // …and a unit wider than the book would make the book shorter than the
    // chapter the reader is looking at.
    expect(bookPageAt(0, 1.5, { page: 1, pages: 5 })).toEqual({ page: 1, pages: 5 });
  });

  it("gives nothing back when there is nothing to measure", () => {
    // Unpaginated (foliate's scroll layout reports no counter at all).
    expect(bookPageAt(0, quarter, { page: 1, pages: 0 })).toBeNull();
    // A book whose chapters carry no text, or a section foliate could not size.
    expect(bookPageAt(0, 0, { page: 1, pages: 5 })).toBeNull();
    expect(bookPageAt(0, -1, { page: 1, pages: 5 })).toBeNull();
  });
});
