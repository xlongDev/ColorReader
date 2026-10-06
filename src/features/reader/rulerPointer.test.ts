import { describe, expect, it } from "vitest";

import {
  RULER_PAD_FACTOR,
  bandOver,
  blockAt,
  clampAnchor,
  crossExtentOf,
  fallbackBand,
  nextBlock,
  nextColumnBlock,
  onPage,
  toColumns,
  toLines,
  toSpans,
  visibleLines,
} from "@/features/reader/rulerPointer";
import type { RulerColumn, RulerInterval, RulerRect } from "@/features/reader/rulerPointer";

/** A rect whose reading-axis extent is `start..end`, in whichever mode. */
const box = (start: number, end: number): RulerRect => ({
  top: start,
  bottom: end,
  left: start,
  right: end,
});

/** A run of text at `left..right` whose line runs `start..end` down the page. */
const text = (left: number, right: number, start: number, end: number): RulerRect => ({
  top: start,
  bottom: end,
  left,
  right,
});

/** Two paragraphs of body text: 26px of leading, and the gap between them. */
const PROSE = [box(100, 126), box(126, 152), box(170, 196), box(196, 222)];

/** Those paragraphs as lines, which is what every rule below is handed. */
const pageLines = (rects: RulerRect[] = PROSE): RulerInterval[] =>
  toLines(toSpans(rects, false, 800));

/** One block's worth of padding, as `bandOver` rounds it. */
const padOf = (pitch: number) => Math.round(pitch * 0.3);

describe("toSpans", () => {
  it("reads horizontal type down the page", () => {
    expect(toSpans([box(100, 126)], false, 800)).toEqual([{ start: 100, end: 126 }]);
  });

  it("reads vertical type leftward from the right edge", () => {
    // Vertical-rl reads right to left, so the column nearest the right edge comes
    // first. Measured from that edge, "forward" then means the same thing in
    // both writing modes and nothing downstream has to know which one it is.
    const rects: RulerRect[] = [text(460, 503, 0, 600), text(417, 460, 0, 600)];
    expect(toSpans(rects, true, 800)).toEqual([
      { start: 800 - 503, end: 800 - 460 },
      { start: 800 - 460, end: 800 - 417 },
    ]);
  });

  it("drops a rect with no extent along the axis", () => {
    // `getClientRects()` reports a zero-height box for a collapsed range; left
    // in, it is a line nothing can sit on.
    expect(toSpans([box(100, 100), box(120, 140)], false, 800)).toEqual([{ start: 120, end: 140 }]);
  });
});

describe("toLines", () => {
  it("collapses the fragments of one line into the line", () => {
    // One line of prose is several rects — one per inline run. Left separate,
    // the band would land on a fragment and span a third of the line.
    const fragments = [box(100, 120), box(100.5, 120.5), box(101, 121)];
    expect(toLines(toSpans(fragments, false, 800))).toEqual([{ start: 100, end: 121 }]);
  });

  it("keeps lines that merely abut apart", () => {
    // Consecutive line boxes touch: the leading is inside them, not between
    // them. Merged, a whole paragraph would become one line and the band would
    // swallow it.
    expect(pageLines()).toEqual([
      { start: 100, end: 126 },
      { start: 126, end: 152 },
      { start: 170, end: 196 },
      { start: 196, end: 222 },
    ]);
  });

  it("folds a taller inline run into the line it sits on", () => {
    // A footnote marker reports a taller rect than its line. Counted as a line
    // of its own, it would push every line after it down one.
    expect(
      toLines([
        { start: 100, end: 126 },
        { start: 104, end: 132 },
        { start: 132, end: 158 },
      ]),
    ).toEqual([
      { start: 100, end: 132 },
      { start: 132, end: 158 },
    ]);
  });

  it("ignores a sub-pixel overlap between two lines", () => {
    // A fractional line height rounds the two boxes into each other by a hair.
    expect(
      toLines([
        { start: 100, end: 126.4 },
        { start: 126, end: 152 },
      ]),
    ).toHaveLength(2);
  });
});

describe("toColumns", () => {
  /** A spread: text in the left column at x 40..240, in the right at 460..660. */
  const spread: RulerRect[] = [
    text(40, 240, 100, 126),
    text(40, 200, 126, 152),
    text(460, 660, 100, 126),
    text(460, 600, 128, 154),
  ];

  it("measures a spread's columns apart, so their line grids never merge", () => {
    // Two flows side by side do not break their paragraphs in the same place.
    // A rule that merged overlaps would read one column's second line as the
    // other's — they are within two pixels of each other here — and the band,
    // sized to that merged line, would then cut through both.
    const columns = toColumns(spread, 2, 0, 800);
    expect(columns).toEqual([
      {
        left: 40,
        right: 240,
        lines: [
          { start: 100, end: 126 },
          { start: 126, end: 152 },
        ],
      },
      {
        left: 460,
        right: 660,
        lines: [
          { start: 100, end: 126 },
          { start: 128, end: 154 },
        ],
      },
    ]);
  });

  it("keeps only the fragments that are on screen", () => {
    // A paginated section is one long strip behind a moving window, so the
    // columns off either edge arrive as rects far outside the reading area.
    // Bucketed, they bring a chapter's worth of lines with them and the band
    // lands on text nobody can see.
    const offscreen = [text(-800, -600, 100, 126), text(900, 1000, 100, 126)];
    const columns = toColumns([...spread, ...offscreen], 2, 0, 800);
    expect(columns).toEqual([
      {
        left: 40,
        right: 240,
        lines: [
          { start: 100, end: 126 },
          { start: 126, end: 152 },
        ],
      },
      {
        left: 460,
        right: 660,
        lines: [
          { start: 100, end: 126 },
          { start: 128, end: 154 },
        ],
      },
    ]);
  });

  it("counts a fragment only when it is on the page being read", () => {
    // A paginated book keeps the pages either side of this one in the document.
    // The neighbour is flush against the area's edge (a fraction of a pixel in)
    // or — after the pane's width changed under it — a whole column of it pokes
    // in; either way its words are not this page's, and counted they drag the
    // band out of the text and into the margin, where it reads as if it had
    // faded out.
    const flush = text(799.8, 1000, 100, 126);
    const stale = text(-600, 60, 100, 126);
    for (const neighbour of [flush, stale]) {
      expect(onPage(neighbour, false, 0, 800)).toBe(false);
      const columns = toColumns([...spread, neighbour], 2, 0, 800);
      expect(columns).toHaveLength(2);
      expect(columns[0]!.left).toBe(40);
    }
  });

  it("keeps a line of this page, even one hanging out of the area", () => {
    // The band covers every line it is drawn over: a line that starts left of
    // the area's own edge is still a line of the page the reader is reading.
    expect(onPage(text(-20, 200, 100, 126), false, 0, 800)).toBe(true);
    expect(onPage(text(650, 900, 100, 126), false, 0, 800)).toBe(true);
    // …and vertical type is measured across the page's own height.
    expect(onPage(text(40, 240, -20, 100), true, 0, 600)).toBe(true);
    expect(onPage(text(40, 240, 620, 700), true, 0, 600)).toBe(false);
  });

  it("gives up when the page shows one column", () => {
    // Nothing to split: the caller measures the page as one flow of lines. Two
    // buckets out of one column would cut every line in half.
    expect(toColumns(spread, 1, 0, 800)).toEqual([]);
  });

  it("drops a column the window has nothing in", () => {
    // A chapter's last spread page can have its text entirely in one column.
    const oneSided = spread.slice(0, 2);
    const columns = toColumns(oneSided, 2, 0, 800);
    expect(columns).toHaveLength(1);
    expect(columns[0]!.left).toBe(40);
  });
});

describe("crossExtentOf", () => {
  it("gives the outermost edges of the text", () => {
    // The band has to cover every line it is drawn over: sized to the middle of
    // the edges, the wash would cut into a dialogue line that hangs left.
    const rects = [text(40, 240, 100, 126), text(40, 220, 126, 152), text(60, 240, 170, 196)];
    expect(crossExtentOf(rects, false)).toEqual({ from: 40, to: 240 });
  });

  it("reads the cross axis the other way for vertical type", () => {
    // Vertical type reads leftward, so its band stands up and the extent that
    // matters is where the columns sit on the page's own height.
    const rects: RulerRect[] = [
      text(460, 503, 40, 600),
      text(417, 460, 30, 620),
      text(430, 470, 44, 590),
    ];
    expect(crossExtentOf(rects, true)).toEqual({ from: 30, to: 620 });
  });

  it("has nothing to give when nothing is measured", () => {
    expect(crossExtentOf([], false)).toBeNull();
  });
});

describe("visibleLines", () => {
  it("keeps only the lines overlapping the reading area", () => {
    // A chapter scrolled past its own start measures entirely above the page;
    // left in, those lines are the only candidates and the band gives up.
    const lines = [
      { start: -1800, end: -1774 },
      { start: 90, end: 116 },
      { start: 116, end: 142 },
      { start: 700, end: 726 },
    ];
    expect(visibleLines(lines, 100, 600)).toEqual([
      { start: 90, end: 116 },
      { start: 116, end: 142 },
    ]);
  });

  it("keeps a line half off the edge of the page", () => {
    // The reader is looking at it, so it is a line of the page.
    expect(visibleLines([{ start: 40, end: 120 }], 100, 600)).toHaveLength(1);
    expect(visibleLines([{ start: 580, end: 640 }], 100, 600)).toHaveLength(1);
  });

  it("drops a line entirely outside", () => {
    expect(visibleLines([{ start: 20, end: 100 }], 100, 600)).toHaveLength(0);
    expect(visibleLines([{ start: 600, end: 680 }], 100, 600)).toHaveLength(0);
  });
});

describe("blockAt", () => {
  it("starts the block at the line the anchor is in", () => {
    // The anchor is the *leading edge* of where the band is wanted, so the block
    // runs on from the reader's line. Centred on the anchor instead, the first
    // and last lines of every block would be cut in half.
    expect(blockAt(pageLines(), 130, 2)).toEqual({ start: 126, end: 196 });
  });

  it("holds the nearest line through the leading", () => {
    // The anchor spends its life between lines — that is what leading is. It is
    // accepted within half a line's advance, not half a glyph box: a page sets
    // its lines further apart than the letters are tall, so most of the page is
    // the space between two boxes.
    expect(blockAt(pageLines(), 160, 1)).toEqual({ start: 126, end: 152 });
  });

  it("gives up on an anchor that is nowhere near a line", () => {
    // A figure, the margin: the caller falls back to arithmetic.
    expect(blockAt(pageLines(), 500, 2)).toBeNull();
  });

  it("has nothing to offer when the block would run past the last line", () => {
    // The caller shifts the block back instead (`nextBlock` from the foot of the
    // page), which is what keeps the band full thickness at the end of a page.
    expect(blockAt(pageLines(), 200, 4)).toBeNull();
  });

  it("has nothing to offer on a page with no lines", () => {
    expect(blockAt([], 140, 2)).toBeNull();
  });
});

describe("nextBlock", () => {
  it("advances exactly one block, never the line it is already on", () => {
    // Forward starts at the first line at or after the block's end. Starting at
    // the band's own first line instead, a step would never get anywhere.
    expect(nextBlock(pageLines(), { start: 100, end: 126 }, 1, 1)).toEqual({
      start: 126,
      end: 152,
    });
  });

  it("advances by whole blocks", () => {
    expect(nextBlock(pageLines(), { start: 100, end: 152 }, 2, 1)).toEqual({
      start: 170,
      end: 222,
    });
  });

  it("runs back the same way", () => {
    expect(nextBlock(pageLines(), { start: 170, end: 196 }, 1, -1)).toEqual({
      start: 126,
      end: 152,
    });
  });

  it("declines past the last block, which is how the page turn is found", () => {
    // `move` reports this as "no block here", and the caller turns the page.
    expect(nextBlock(pageLines(), { start: 196, end: 222 }, 1, 1)).toBeNull();
  });

  it("declines past the first block", () => {
    expect(nextBlock(pageLines(), { start: 100, end: 126 }, 1, -1)).toBeNull();
  });

  it("takes what is there at the foot of the page", () => {
    // The band reached the bottom margin: the last whole block on the page is
    // the honest answer, and it is also where a step back would have landed.
    expect(nextBlock(pageLines(), { start: Infinity, end: Infinity }, 2, -1)).toEqual({
      start: 170,
      end: 222,
    });
  });

  it("has nothing to offer on a page with no lines", () => {
    expect(nextBlock([], { start: 0, end: 0 }, 1, 1)).toBeNull();
  });
});

describe("nextColumnBlock", () => {
  const columns: RulerColumn[] = [
    {
      left: 40,
      right: 240,
      lines: [
        { start: 100, end: 126 },
        { start: 126, end: 152 },
      ],
    },
    {
      left: 460,
      right: 660,
      lines: [
        { start: 100, end: 126 },
        { start: 128, end: 154 },
      ],
    },
  ];

  it("steps down the column it is in", () => {
    expect(nextColumnBlock(columns, 0, { start: 100, end: 126 }, 1, 1)).toEqual({
      index: 0,
      block: { start: 126, end: 152 },
    });
  });

  it("carries into the next column at its first block", () => {
    // The page is not over when the column is: the spread's second flow is the
    // next thing the reader reads.
    expect(nextColumnBlock(columns, 0, { start: 126, end: 152 }, 1, 1)).toEqual({
      index: 1,
      block: { start: 100, end: 126 },
    });
  });

  it("runs back into the previous column at its last block", () => {
    expect(nextColumnBlock(columns, 1, { start: 100, end: 126 }, 1, -1)).toEqual({
      index: 0,
      block: { start: 126, end: 152 },
    });
  });

  it("declines past the last column, which is where the page turns", () => {
    expect(nextColumnBlock(columns, 1, { start: 128, end: 154 }, 1, 1)).toBeNull();
  });

  it("declines before the first", () => {
    expect(nextColumnBlock(columns, 0, { start: 100, end: 126 }, 1, -1)).toBeNull();
  });

  it("has nothing to offer on a page with no columns", () => {
    expect(nextColumnBlock([], 0, { start: 0, end: 0 }, 1, 1)).toBeNull();
  });
});

describe("bandOver", () => {
  it("pads the block on both sides and centres it", () => {
    // Three tenths of a line each way, which is the reference's own figure: the
    // band never looks like it is clipping the line above it, and equal padding
    // on both sides is what makes it read as centred on the lines it marks.
    const band = bandOver({ start: 100, end: 152 }, 26, 2);
    const pad = padOf(26);
    expect(band).toEqual({ start: 100 - pad, end: 152 + pad });
    expect((band.start + band.end) / 2).toBeCloseTo(126);
  });

  it("caps a block taller than the lines it claims, from its front edge", () => {
    // A full-page image inside the block measures taller than any block of
    // lines; uncapped, the band would cover the page it is meant to clarify.
    const band = bandOver({ start: 100, end: 900 }, 26, 2);
    expect(band.end - band.start).toBeCloseTo(26 * 3);
    // From the front, not around the middle: a block spanning a gap taller than
    // its leading has its centre *between* lines, and a band centred there
    // washes empty paper instead of the words. Measured on a real book, the band
    // landed 400px below the title it was marking.
    expect(band.start).toBe(100 - Math.round(26 * RULER_PAD_FACTOR));
  });

  it("stays inside a block that is shorter than the lines it claims", () => {
    // One line, two requested: the band cannot be taller than what it covers.
    const band = bandOver({ start: 100, end: 126 }, 26, 2);
    expect(band.end).toBeLessThanOrEqual(126 + Math.round(26 * RULER_PAD_FACTOR));
  });

  it("takes only the whitespace there is when the lines have no air", () => {
    // A book whose leading is tighter than its own type is high: the line boxes
    // overlap, so two consecutive lines share 3.4px of box and there is no
    // whitespace between them at all. Three tenths of that advance is 6px, and
    // padding by it put each edge inside the neighbouring line — which is what
    // 「上下均超出了一些」 is. Measured on a real book (《认识世界》, 18px,
    // 跟随书籍): the band overran by 9.4px at the top and 6.0px at the bottom.
    const tight = toLines(toSpans([box(0, 25), box(21.6, 46.6), box(43.2, 68.2)], false, 800));
    expect(tight).toHaveLength(3);
    const band = bandOver({ start: 21.6, end: 46.6 }, 21.6, 1, tight);
    // No padding at all: the band is exactly the lines it marks. Note what the
    // relation can and cannot be here — the neighbour's box already reaches 3.4px
    // into the block, so "clear of the line above" is not available as a
    // comparison at all. What the band must not do is *add* to the overlap.
    expect(band).toEqual({ start: 21.6, end: 46.6 });
    expect(band.start).toBeGreaterThanOrEqual(21.6);
    expect(band.end).toBeLessThanOrEqual(46.6);
  });

  it("still takes three tenths of a line where the page has the room", () => {
    // The same page with the reader owning the leading: 32.4px a line against a
    // 25px line box leaves 7.4px of real whitespace, and the padding the design
    // asks for is 10px — more than the gap, so the cap applies and the band
    // fills the gap without crossing it. What must not regress is the band's
    // reach *into* the neighbouring line: that is zero either way.
    const roomy = toLines(toSpans([box(0, 25), box(32.4, 57.4), box(64.8, 89.8)], false, 800));
    const band = bandOver({ start: 32.4, end: 57.4 }, 32.4, 1, roomy);
    expect(band.start).toBeGreaterThanOrEqual(roomy[0]!.end);
    expect(band.end).toBeLessThanOrEqual(roomy[2]!.start);
    // …and it is still padded, not welded to the text: the band is thicker than
    // the lines it marks.
    expect(band.end - band.start).toBeGreaterThan(25);
  });

  it("measures the air off the block, not off the page's leading", () => {
    // A block that ends a paragraph has a paragraph gap below it, not another
    // step: a padding sized from the leading alone would claim 8px where there
    // are 40. And one that starts a paragraph has the same above it.
    const lines = toLines(
      toSpans([box(0, 25), box(26, 51), box(92, 117), box(118, 143)], false, 200),
    );
    const band = bandOver({ start: 92, end: 117 }, 26, 1, lines);
    // Above: 92 - 51 = 41px of air. Below: 118 - 117 = 1px. The nearer side
    // decides — pad by the 1px, not by the 8 the fraction would have asked for.
    expect(band.start).toBe(92 - 1);
    expect(band.end).toBe(117 + 1);
  });
});

describe("fallbackBand", () => {
  it("centres the reader's own leading on the anchor", () => {
    const band = fallbackBand(400, 26, 2);
    expect(band.end - band.start).toBeCloseTo(52);
    expect((band.start + band.end) / 2).toBe(400);
  });

  it("has a band even for a nonsensical line count", () => {
    // The store's steppers cannot send this, but a persisted value from an older
    // build could, and a zero-thickness band is invisible rather than wrong.
    expect(fallbackBand(400, 26, 0).end - fallbackBand(400, 26, 0).start).toBeCloseTo(26);
  });
});

describe("clampAnchor", () => {
  it("keeps the whole band inside the reading area", () => {
    expect(clampAnchor(0, 60, 0, 800)).toBe(30);
    expect(clampAnchor(900, 60, 0, 800)).toBe(770);
    expect(clampAnchor(400, 60, 0, 800)).toBe(400);
  });

  it("centres a band too thick for the area", () => {
    expect(clampAnchor(10, 900, 0, 800)).toBe(400);
  });
});
