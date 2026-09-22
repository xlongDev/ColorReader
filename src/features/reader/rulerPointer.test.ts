import { describe, expect, it } from "vitest";

import {
  RULER_OVERLAP_PX,
  bandOver,
  blockAt,
  clampAnchor,
  crossExtentOf,
  fallbackBand,
  nextBlock,
  nextColumnBlock,
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

  it("counts a fragment only when it is inside the window by more than a hair", () => {
    // A paginated book keeps the page it is not showing flush against the
    // window: its fragments begin a fraction of a pixel past the edge, and
    // counted, they drag the band tens of pixels clear of the text — into the
    // margin, where the band reads as if it had faded out.
    const neighbour = text(799.8, 1000, 100, 126);
    const columns = toColumns([...spread, neighbour], 2, 0, 800);
    expect(columns).toHaveLength(2);
    expect(columns[1]!.right).toBe(660);
    // A line the reader can see half of is a line of the page.
    const halfShown = text(760, 1000, 100, 126);
    expect(toColumns([...spread, halfShown], 2, 0, 800)).toHaveLength(2);
    expect(RULER_OVERLAP_PX).toBeGreaterThan(0);
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

  it("caps a block taller than the lines it claims", () => {
    // A full-page image inside the block measures taller than any block of
    // lines; uncapped, the band would cover the page it is meant to clarify.
    const band = bandOver({ start: 100, end: 900 }, 26, 2);
    expect(band.end - band.start).toBeCloseTo(26 * 3);
    expect((band.start + band.end) / 2).toBeCloseTo(500);
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
