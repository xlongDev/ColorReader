import type { ChapterMeta } from "@/types/ipc";

/** Sum of every chapter's character count. */
export function totalChars(chapters: ChapterMeta[]): number {
  return chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
}

/**
 * Maps a global 0..1 progress fraction onto a chapter and the fraction within
 * it, using character counts so no content is loaded to locate the position.
 */
export function locateChapter(
  chapters: ChapterMeta[],
  progress: number,
): { idx: number; fraction: number } {
  if (chapters.length === 0) return { idx: 0, fraction: 0 };

  const at = Math.min(Math.max(progress, 0), 1);
  const total = totalChars(chapters);
  // Nothing to weigh by: a PDF whose text is still owed, or whose extraction
  // never succeeded. Collapsing the book onto chapter 0 would lose the saved
  // place *and* pin every later write at zero, because the inverse below would
  // keep answering 0 — the position would never advance again. One unit per
  // chapter keeps the mapping usable; for a PDF the chapter *is* the page, so
  // this is the right model rather than a stopgap.
  if (total <= 0) {
    return { idx: Math.min(chapters.length - 1, Math.floor(at * chapters.length)), fraction: 0 };
  }

  const target = at * total;
  let before = 0;
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const chars = chapter.chars;
    if (target < before + chars || i === chapters.length - 1) {
      const fraction = chars > 0 ? (target - before) / chars : 0;
      return { idx: i, fraction: Math.min(Math.max(fraction, 0), 1) };
    }
    before += chars;
  }
  return { idx: chapters.length - 1, fraction: 1 };
}

/** Global progress from a chapter position, for persisting. */
export function globalProgress(chapters: ChapterMeta[], idx: number, fraction: number): number {
  if (chapters.length === 0) return 0;
  const total = totalChars(chapters);
  // The inverse of the equal-weight branch above: see there for why a book with
  // no text must not answer 0.
  if (total <= 0) {
    const clamped = Math.max(0, Math.min(idx, chapters.length - 1));
    return (clamped + Math.min(Math.max(fraction, 0), 1)) / chapters.length;
  }

  const clamped = Math.max(0, Math.min(idx, chapters.length - 1));
  let before = 0;
  for (let i = 0; i < clamped; i++) before += chapters[i]!.chars;
  const chapter = chapters[clamped]!;
  return (before + chapter.chars * Math.min(Math.max(fraction, 0), 1)) / total;
}

/** Characters from the current position to the end of the book. */
export function remainingChars(chapters: ChapterMeta[], idx: number, fraction: number): number {
  const total = totalChars(chapters);
  const before = globalProgress(chapters, idx, fraction) * total;
  return Math.max(0, Math.round(total - before));
}

/**
 * Human reading-time label for a character count at `charsPerMinute`.
 * Sub-minute stays are called out instead of rounding to a bare zero.
 */
export function estimateLabel(chars: number, charsPerMinute: number): string {
  if (charsPerMinute <= 0) return "未知";
  const minutes = chars / charsPerMinute;
  if (minutes < 1) return "不到 1 分钟";
  const whole = Math.floor(minutes);
  if (whole < 60) return `约 ${whole} 分钟`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `约 ${hours} 小时` : `约 ${hours} 小时 ${rest} 分钟`;
}

/**
 * Where in the book a position lands, given the book's whole page count.
 *
 * The whole-book indicator works the other way round than a unit's counter:
 * the book's length is worked out first (`bookPagesOf`), and a position is
 * that count times how far into the book it is. `before` is that fraction —
 * `globalProgress` hands out exactly it, boundary and position inside the
 * chapter included.
 *
 * Clamped at both ends: the last fraction a layout reports can round up past
 * the count, and "301 / 300 页" is a printed number disagreeing with itself.
 */
export function bookPageOf(before: number, pages: number): { page: number; pages: number } {
  return { page: Math.min(pages, Math.max(1, Math.round(before * pages) + 1)), pages };
}

/**
 * A unit's page count as the layout counted it, by unit — the tally the prose
 * pager's whole-book count is built from. Keyed by unit so a unit measured
 * again replaces its own entry rather than counting twice: a re-layout
 * re-paginates every chapter, and after a chapter roll-over the chapter being
 * left is still on screen when the new one is first measured.
 */
export type PageTally = Map<number, number>;

export const emptyTally = (): PageTally => new Map();

/** Records one unit's measurement, replacing whatever it reported before. */
export function observeUnit(tally: PageTally, unit: number, pages: number): void {
  if (pages <= 0) return;
  tally.set(unit, pages);
}

/**
 * A unit too short to be evidence about pages of text: a cover, a plate, a
 * divider — and any chapter that fits on one page, where the page break at the
 * end is most of what the "page" is. A last page is never full, so the shorter
 * the unit, the worse its characters-per-page reads.
 */
const MIN_SAMPLE_PAGES = 2;

/** Characters per page at this tally, averaged over the units long enough to
 *  be evidence — or `null` while none of them is. */
function charsPerPage(tally: PageTally, chapters: readonly ChapterMeta[]): number | null {
  let chars = 0;
  let pages = 0;
  for (const [index, measured] of tally) {
    if (measured < MIN_SAMPLE_PAGES) continue;
    chars += chapters[index]?.chars ?? 0;
    pages += measured;
  }
  return chars > 0 && pages > 0 ? chars / pages : null;
}

/**
 * The whole book's page count: chapters already measured count as measured,
 * and the ones not yet read are sized at the density those chapters set.
 *
 * A book's length is a property of the book — it must not move while it is
 * being read — so this is deliberately *not* "measured pages over measured
 * share". That form lets the chapter under the cursor set the book's density
 * and the total changes as the reader moves: the same EPUB reported 493, 977,
 * 805, 2202 and 939 pages to one reader. Here every chapter contributes
 * exactly once, so the count walks towards the truth as the book is read
 * instead of swinging around it.
 *
 * `null` until a chapter long enough to be evidence has been measured — until
 * then there is nothing to size the unread ones with, and the caller keeps the
 * chapter's own counter.
 */
export function bookPagesOf(tally: PageTally, chapters: readonly ChapterMeta[]): number | null {
  const perPage = charsPerPage(tally, chapters);
  if (perPage === null) return null;
  let pages = 0;
  for (let index = 0; index < chapters.length; index += 1) {
    // At least one page: a page is the least a chapter can be.
    const estimated = Math.max(1, Math.round((chapters[index]?.chars ?? 0) / perPage));
    pages += tally.get(index) ?? estimated;
  }
  return Math.max(1, pages);
}

/**
 * foliate's own whole-book page counter, as the indicator shows it.
 *
 * foliate numbers reading positions the way a Kindle does: the book's text is
 * cut into a fixed number of *sizes* — 1500 bytes each, `SectionProgress` — and
 * both numbers the reader sees come off that scale. `total` is a property of
 * the book's bytes, and `current` only ever goes up, so neither moves when a
 * page is turned or the font is changed: the two things that made an estimate
 * useless here. (readest shows this same counter, and only uses a book's own
 * page list when it ships one.)
 *
 * `current` is zero-based, and one page turn can move it by more than one, so
 * the position is clamped to the total: the last page snaps there, and
 * "468 / 467 页" is a printed number disagreeing with itself.
 *
 * `null` when foliate has not built its table yet (`location` is absent before
 * sections arrive), which leaves the caller on the section's own counter.
 */
export function bookPageFromLocation(
  location?: { current: number; next: number; total: number } | null,
): { page: number; pages: number } | null {
  if (!location || location.total <= 0) return null;
  return {
    page: Math.min(location.total, Math.max(1, location.current + 1)),
    pages: location.total,
  };
}
