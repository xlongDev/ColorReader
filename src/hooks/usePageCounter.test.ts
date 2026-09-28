import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usePageCounter, type PageCounterOptions } from "@/hooks/usePageCounter";
import type { ChapterMeta } from "@/types/ipc";

/**
 * Three chapters of 1000 / 2000 / 3000 characters, so a measured chapter sets
 * the book's density and the unread ones can be sized by hand:
 *
 *   count(4) at chapter 0  → density 1000 chars / 4 pages = 250
 *                          → 4 + round(2000/250) + round(3000/250) = 4 + 8 + 12 = 24
 */
const CHAPTERS: ChapterMeta[] = [
  { idx: 0, title: "一", chars: 1000 },
  { idx: 1, title: "二", chars: 2000 },
  { idx: 2, title: "三", chars: 3000 },
];

function setup(overrides: Partial<PageCounterOptions> = {}) {
  const options: PageCounterOptions = {
    unit: "book",
    chapterIsPage: false,
    useFoliate: false,
    chapters: CHAPTERS,
    chapterIdx: 0,
    fraction: 0,
    pageInfo: null,
    foliatePage: null,
    foliateBookPage: null,
    densityKey: "scroll|16|1|1|1|1|0",
    chapterMissing: false,
    ...overrides,
  };
  return renderHook((props: PageCounterOptions) => usePageCounter(props), {
    initialProps: options,
  });
}

describe("usePageCounter", () => {
  it("prints nothing when the reader turned the indicator off", () => {
    const { result } = setup({ unit: "off", pageInfo: { page: 2, pages: 9 } });
    expect(result.current.shown).toBeNull();
  });

  it("counts a format whose chapters are their pages off the chapter list", () => {
    // Exact already: an image-only PDF page carries no text to weigh, so
    // estimating it only adds error.
    const { result } = setup({ chapterIsPage: true, chapterIdx: 2, unit: "book" });
    expect(result.current.shown).toEqual({ page: 3, pages: 3, estimated: false });
  });

  it("prints the layout's own counter for the chapter unit", () => {
    const { result } = setup({ unit: "chapter", pageInfo: { page: 2, pages: 9 } });
    expect(result.current.shown).toEqual({ page: 2, pages: 9, estimated: false });
  });

  it("prints nothing before the unit's counter has landed", () => {
    const { result } = setup({ unit: "chapter", pageInfo: null });
    expect(result.current.shown).toBeNull();
  });

  /**
   * The whole reason the tally exists: the `book` unit is what the reader has
   * measured plus what the rest of the book weighs at that density.
   */
  it("estimates the book's length from the tally, and says it is an estimate", () => {
    const { result } = setup({
      pageInfo: { page: 1, pages: 4 },
      fraction: 0.5,
    });

    // Nothing measured yet: there is no density to size the rest of the book
    // with, so the unit's own counter stands in — and it is not an estimate.
    expect(result.current.shown).toEqual({ page: 1, pages: 4, estimated: false });

    act(() => result.current.count(4));

    // globalProgress(0, 0.5) = 500/6000 = 1/12; 1/12 × 24 pages → page 3.
    expect(result.current.shown).toEqual({ page: 3, pages: 24, estimated: true });
  });

  it("falls back to the unit's counter for a chapter with no text to weigh", () => {
    const chapters: ChapterMeta[] = [
      { idx: 0, title: "封面", chars: 0 },
      { idx: 1, title: "一", chars: 2000 },
    ];
    const { result } = setup({
      chapters,
      chapterIdx: 0,
      unit: "book",
      pageInfo: { page: 1, pages: 1 },
    });

    act(() => result.current.count(6));
    expect(result.current.shown).toEqual({ page: 1, pages: 1, estimated: false });
  });

  it("uses foliate's own whole-book counter on the Kindle path", () => {
    const { result } = setup({
      useFoliate: true,
      foliatePage: { page: 3, pages: 12 },
      foliateBookPage: { page: 41, pages: 180 },
    });

    // foliate numbers positions off the book's bytes, so this one is fixed for
    // the book and is never labelled an estimate.
    expect(result.current.shown).toEqual({ page: 41, pages: 180, estimated: false });
  });

  it("keeps foliate's section counter until its whole-book table exists", () => {
    const { result } = setup({
      useFoliate: true,
      foliatePage: { page: 3, pages: 12 },
      foliateBookPage: null,
    });

    expect(result.current.shown).toEqual({ page: 3, pages: 12, estimated: false });
  });

  it("stays silent until the chapter body is on screen", () => {
    const { result } = setup({
      chapterMissing: true,
      pageInfo: { page: 1, pages: 4 },
      fraction: 0.5,
    });

    act(() => result.current.count(4));

    // Nothing was filed, so there is no tally to size the book with: the unit's
    // own counter still stands, exactly as it does before the first
    // measurement. (Without the guard this reads 3 / 24, estimated.)
    expect(result.current.shown).toEqual({ page: 1, pages: 4, estimated: false });
  });

  /**
   * A re-layout re-paginates every chapter, so pages measured under the old one
   * would be mixed into a density that no longer exists. The observable
   * difference is the book's length: keeping the stale entry reads 20 pages
   * (density 3000/10) where starting over reads 18 (2000/6).
   */
  it("starts the tally over when the layout changes", () => {
    const { result, rerender } = setup({
      pageInfo: { page: 1, pages: 4 },
      densityKey: "scroll|16|1|1|1|1|0",
    });

    act(() => result.current.count(4));

    rerender({
      unit: "book",
      chapterIsPage: false,
      useFoliate: false,
      chapters: CHAPTERS,
      chapterIdx: 1,
      fraction: 0,
      pageInfo: { page: 1, pages: 6 },
      foliatePage: null,
      foliateBookPage: null,
      densityKey: "double|16|1|1|1|1|0",
      chapterMissing: false,
    });
    act(() => result.current.count(6));

    // 18, not 20 — and chapter 1 starts a sixth of the way in, so page 4.
    expect(result.current.shown).toEqual({ page: 4, pages: 18, estimated: true });
  });

  /** `count` goes into the scroll handler's dependency list, so a fresh
   *  identity on every render would re-register it for nothing. */
  it("keeps count stable across a render that changes nothing it reads", () => {
    const { result, rerender } = setup();
    const first = result.current.count;

    rerender({
      unit: "book",
      chapterIsPage: false,
      useFoliate: false,
      chapters: CHAPTERS,
      chapterIdx: 0,
      fraction: 0.25,
      pageInfo: { page: 1, pages: 4 },
      foliatePage: null,
      foliateBookPage: null,
      densityKey: "scroll|16|1|1|1|1|0",
      chapterMissing: false,
    });

    expect(result.current.count).toBe(first);
  });
});
