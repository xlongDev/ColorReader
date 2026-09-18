import { describe, expect, it } from "vitest";

import { SectionProgress } from "foliate-js/progress.js";

import { bookPageAt } from "@/features/reader/progress";

/**
 * The foliate half of the whole-book page estimate.
 *
 * `ReaderPage` builds the estimate's `span` out of two numbers foliate hands
 * over separately: the section boundaries (`View.getSectionFractions()`, which
 * is `SectionProgress.sectionFractions`) and the index a relocate reports
 * (`progress.section.current`). The estimate is only meaningful if those two
 * index the *same* array — and getting that wrong produces a page number that
 * looks entirely plausible, which is why it is pinned here rather than trusted.
 *
 * This is someone else's module, so the test is deliberately narrow: it asserts
 * the three facts the app relies on, not foliate's behaviour in general. If a
 * foliate upgrade reshapes any of them, this fails here instead of printing a
 * wrong page number in the reader.
 *
 * What it cannot cover: whether foliate ever *calls* `getProgress` with the
 * index we assume. That is `View`'s business and is best pinned with a real
 * book (a reader ran the foliate path on an EPUB and the 全书 page count
 * tracked the section weights it reported back, on 2026-09-18 — so the
 * link from `onRelocate` to `SectionProgress` is now exercised in the
 * running app, just not by this test).
 */

/** `size` is foliate's byte count for a section; `linear: "no"` is skipped. */
function sections(sizes: number[]) {
  return sizes.map((size) => ({ linear: "yes", size }));
}

describe("foliate's section-progress table", () => {
  it("leads with a hard zero and ends at one, one entry per boundary", () => {
    const progress = new SectionProgress(sections([100, 300, 100]), 1500, 1600);

    // Four entries for three sections: `[i]` starts section `i`, `[i + 1]`
    // ends it. `ReaderPage` reads exactly that pair.
    expect(progress.sectionFractions).toHaveLength(4);
    expect(progress.sectionFractions[0]).toBe(0);
    expect(progress.sectionFractions[3]).toBeCloseTo(1);
    expect(progress.sectionFractions[1]).toBeCloseTo(0.2);
    expect(progress.sectionFractions[2]).toBeCloseTo(0.8);
  });

  it("reports the index the fractions array is indexed by", () => {
    const progress = new SectionProgress(sections([100, 300, 100]), 1500, 1600);

    for (const index of [0, 1, 2]) {
      const { section } = progress.getProgress(index, 0, 0);
      expect(section.current, `section ${index} reported itself as another`).toBe(index);
      // The end of that section is the start of the next one — the pair
      // `bookPageAt` is handed as (before, span).
      expect(progress.sectionFractions[index + 1]).toBeGreaterThan(
        progress.sectionFractions[index]!,
      );
    }
    expect(progress.getProgress(1, 0, 0).section.total).toBe(3);
  });

  it("gives the last section a span that reaches the end of the book", () => {
    const progress = new SectionProgress(sections([100, 300, 100]), 1500, 1600);
    const last = progress.sectionFractions.length - 2;
    expect(progress.sectionFractions[last + 1]).toBeCloseTo(1);
  });

  it("skips a section that is not in the linear reading order", () => {
    // `linear: "no"` and a zero-byte section both weigh nothing, so they get no
    // share of the book. The estimate divides by the span, so a zero span must
    // stay a zero span rather than becoming a division by nothing.
    const progress = new SectionProgress(
      [
        { linear: "yes", size: 100 },
        { linear: "no", size: 300 },
        { linear: "yes", size: 100 },
      ],
      1500,
      1600,
    );
    expect(progress.sectionFractions[1]).toBeCloseTo(0.5);
    expect(progress.sectionFractions[2]! - progress.sectionFractions[1]!).toBe(0);
  });

  it("feeds the estimator a span it can use, and a zero span it refuses", () => {
    const progress = new SectionProgress(sections([100, 300, 100]), 1500, 1600);
    const start = progress.sectionFractions[1]!;
    const span = progress.sectionFractions[2]! - start;

    // A 300-byte section holding 0.6 of the book (the other two are 100 each),
    // paginated into 6 pages. On its 2nd page: 0.2 of the way in, 6 pages per
    // 0.6 of book = 10 pages of book, so page 4.
    expect(bookPageAt(start, span, { page: 2, pages: 6 })).toEqual({ page: 4, pages: 10 });

    // The non-linear section: no span, so no estimate — the caller falls back
    // to the section counter rather than printing a number it made up.
    expect(bookPageAt(progress.sectionFractions[1]!, 0, { page: 1, pages: 4 })).toBeNull();
  });
});
