import { describe, expect, it } from "vitest";

import { SectionProgress } from "foliate-js/progress.js";

import { bookPageFromLocation } from "@/features/reader/progress";

/**
 * The foliate half of the whole-book page indicator.
 *
 * foliate numbers reading positions the way a Kindle does: a section's byte
 * size is the book's unit of length, and `SectionProgress` turns a position
 * into `location = { current, next, total }` on a fixed scale (1500 bytes a
 * page). `View` puts that straight into the `relocate` detail, and the whole-
 * book indicator prints it (`bookPageFromLocation`).
 *
 * Both numbers a reader sees therefore come off the book's bytes, which is the
 * property worth pinning: the total cannot move while the book is read, and
 * the position can only go up. The estimate that used to stand here —
 * extrapolating the book from the section on screen — moved by hundreds of
 * pages between two turns, and this test is the shape of the thing that
 * replaced it.
 *
 * This is someone else's module, so the test is deliberately narrow: it
 * asserts the facts the app relies on, not foliate's behaviour in general. If a
 * foliate upgrade reshapes any of them, this fails here instead of printing a
 * wrong page number in the reader.
 *
 * What it cannot cover: whether foliate ever *calls* `getProgress` with the
 * index and fraction we assume. That is `View`'s business and is best pinned
 * with a real book.
 */

/** `size` is foliate's byte count for a section; `linear: "no"` is skipped. */
function sections(sizes: number[]) {
  return sizes.map((size) => ({ linear: "yes", size }));
}

/** 15 KB + 45 KB + 15 KB = 75 KB, which is 50 pages at 1500 bytes a page. */
const BOOK = [15_000, 45_000, 15_000];
const PAGE = 1500;

describe("foliate's location counter", () => {
  it("is the book's length, not the section's", () => {
    const progress = new SectionProgress(sections(BOOK), PAGE, 1600);
    const start = progress.getProgress(0, 0, 0).location;

    expect(start.total).toBe(50);
    // Every position in the book reports the same total — the counter is a
    // property of the book's bytes, and that is why it never moves.
    for (const [index, fraction] of [
      [0, 0.5],
      [1, 0.25],
      [1, 0.9],
      [2, 1],
    ] as const) {
      expect(progress.getProgress(index, fraction, 0).location.total).toBe(50);
    }
  });

  it("advances with the reader and stops at the end", () => {
    const progress = new SectionProgress(sections(BOOK), PAGE, 1600);
    // Section 0 is 10 pages, so section 1 starts on page 11 and its middle is
    // page 26. Zero-based, and one turn can move it by more than one.
    expect(progress.getProgress(0, 0, 0).location.current).toBe(0);
    expect(progress.getProgress(1, 0, 0).location.current).toBe(10);
    expect(progress.getProgress(1, 0.5, 0).location.current).toBe(25);
    // The very end is the total, not one past it: the indicator clamps the
    // one-based position, so the last page reads "50 / 50 页".
    const end = progress.getProgress(2, 1, 0).location;
    expect(end.current).toBe(50);
    expect(bookPageFromLocation(end)).toEqual({ page: 50, pages: 50 });
  });

  it("gives a section outside the reading order no share of the book", () => {
    // A cover or a nav document is `linear: "no"`: it carries no part of the
    // length, and reading through it does not move the position. The page a
    // reader sees there is the page the chapter start is on.
    const progress = new SectionProgress(
      [
        { linear: "yes", size: 15_000 },
        { linear: "no", size: 45_000 },
        { linear: "yes", size: 15_000 },
      ],
      PAGE,
      1600,
    );
    expect(progress.getProgress(0, 0, 0).location.total).toBe(20);
    expect(progress.getProgress(1, 0, 0).location.current).toBe(10);
    expect(progress.getProgress(2, 0, 0).location.current).toBe(10);
  });

  it("reads as the indicator, one-based", () => {
    const progress = new SectionProgress(sections(BOOK), PAGE, 1600);
    // A fifth of the way into section 1 — byte 15000 + 9000 — is page 17.
    expect(bookPageFromLocation(progress.getProgress(1, 0.2, 0).location)).toEqual({
      page: 17,
      pages: 50,
    });
  });
});
