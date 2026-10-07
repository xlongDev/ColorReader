/**
 * The reading ruler's geometry: where the band sits, and the real lines of type
 * it lands on.
 *
 * The band is a window cut in the page — everything outside it is washed toward
 * the paper, so the eye has one lit strip of type — and it is drawn around a
 * *block of real lines*, not at an arithmetic offset. The reader's settings say
 * how many lines that block holds; where the lines actually are comes from the
 * renderer (`Range.getClientRects()`), because fonts, inline images, headings
 * and CSS overrides all move them, and an arithmetic band drifts off the text
 * within a paragraph or two.
 *
 * The block is what makes it a ruler rather than a stripe: it advances by whole
 * blocks, so it never ends up half a line off, and it is *centred* on its block
 * so the breathing room above and below is equal. The band is therefore as
 * thick as the text it marks, plus a little padding — the reader's line count
 * sizes the *step*, and a step is a block of that many lines, so it sizes the
 * band too.
 *
 * Two things then have to be true of it. The first is that it lands on *lines*
 * and not on the space between them — reading a page whose leading is wider
 * than its glyphs means the reader's eye is on a line at any moment, so a band
 * an odd half-line off marks nothing. The second is that the page moving under
 * it is the point: the band stays where it is, and after a page turn it is
 * re-derived from the page it is now over rather than remembered.
 *
 * Both fall out of asking the renderer where the lines actually are. A line
 * here is one interval along the reading axis, and the axis always runs in
 * *reading* order whichever way the type does: down the page for horizontal
 * text, and — for vertical-rl, where the next column is to the *left* —
 * leftward, measured from the right edge. Everything in this file then reads
 * the same way for both writing modes: forward is increasing, `start` is where
 * the reader is, and the renderer flips the axis back when it draws.
 *
 * The intervals come from text nodes (`Range.getClientRects()`), never from a
 * range spanning elements: a range over a container reports the border box of
 * everything it encloses, so a multi-line paragraph arrives as one rect as tall
 * as the paragraph and the band snaps to the whole block. A text node can only
 * ever report lines.
 *
 * Everything here is in the reading viewport's own coordinates, so a caller
 * translates the renderer's rects once and then never thinks about frames.
 */

/** A rectangle in the reading viewport's own coordinates. */
export type RulerRect = { top: number; bottom: number; left: number; right: number };

/**
 * One line of type, as its extent along the reading axis, in the reading
 * viewport's own coordinates. `start`/`end` are the leading and trailing edge in
 * reading order — not up/down, not left/right.
 */
export type RulerInterval = { start: number; end: number };

/**
 * One column of a multi-column page: where its text sits across the page (the
 * middle of its fragments' edges — see `crossExtentOf`), and the lines inside
 * it, in reading order.
 *
 * A spread is two independent flows side by side, and their line grids do not
 * agree — one column's paragraph may break where the other's does not — so
 * their lines must never be merged. Merging is what an overlap rule does to
 * them (each column's third line overlaps the other's third line, so the two
 * read as one line and the band's edges then cut through both), and it is why a
 * multi-column band covers *one* column at a time.
 */
export type RulerColumn = { left: number; right: number; lines: RulerInterval[] };

/**
 * Breathing room on each side of the block, in line heights. readest — the
 * reference this feature was built against — pads three tenths of a line, which
 * is enough that the band never looks like it is clipping the line above, and
 * little enough that it still reads as spanning exactly the chosen lines.
 */
export const RULER_PAD_FACTOR = 0.3;

/**
 * The channel the page uses to say "the lines have moved, measure again".
 *
 * A page turn inside a foliate book is a scroll of a translated section, not a
 * DOM change in the reader's own document, so nothing here would notice. The
 * view relays it, in the same way and for the same reason as the section
 * pointer relay this feature used to have: the events a section fires stop at
 * its document boundary.
 *
 * `detail` is the way the page moved, and it is the difference between a page
 * the reader has arrived *on* and a page that moved *under* the band: forward
 * (1) or backward (-1) lands the band on that page's first or last block of
 * lines — the reader continues where the page starts — while 0 leaves the band
 * where it is, which is what a page that scrolled beneath a ruler does.
 */
export const RULER_LAYOUT_EVENT = "reading-ruler-layout";

/** Relays one relayout — a page turn, a repagination — to the ruler. */
export function relayRulerLayout(target: Element | null, dir: 1 | -1 | 0 = 0) {
  target?.dispatchEvent(
    new CustomEvent(RULER_LAYOUT_EVENT, { bubbles: true, detail: { dir, landed: true } }),
  );
}

/**
 * Relays the *start* of a turn: the page is still moving, and a band drawn on a
 * page that is leaving is the band riding the old page down to its last line.
 * The ruler hides until the turn's own `relayRulerLayout` — sent once the page
 * has stopped moving — lands it on the page that arrived.
 */
export function relayRulerTurn(target: Element | null, dir: 1 | -1) {
  target?.dispatchEvent(
    new CustomEvent(RULER_LAYOUT_EVENT, { bubbles: true, detail: { dir, landed: false } }),
  );
}

/** Sections whose keys have already been carried over — one listener per window. */
const relayedKeys = new WeakSet<Window>();

/**
 * The same boundary, on the keyboard: an arrow pressed with the caret inside a
 * book section never reaches the reader's own window.
 *
 * An iframe is its own browsing context, so its events stop at its edge — and
 * foliate puts the caret in the section's own window after every page it lays
 * out (`paginator.focusView`, on `goTo` and on the resize that a change of
 * writing mode or page size causes). So this is not a corner case, it is the
 * state the reader is in after the first page turn: the caret sits on some `<p>`
 * inside the section, and from there every arrow the reader presses is dropped.
 *
 * Measured with the caret in a section of a real book: a `keydown` listener on
 * `window` saw **none** of three presses, and `move` was never called — the band
 * sat on the page and the keys did nothing at all. Not only the ruler's: foliate
 * binds no arrow keys of its own anywhere, so the page turns were gone too.
 *
 * So the section's window is listened to as well and the key is replayed on ours.
 * Arrows only, and only plain ones: those are the keys the reader's own window
 * answers for (the ruler steps, or the page turns when the ruler is off or the
 * page runs out), and a modified arrow — Shift to select, Ctrl/Cmd to move by
 * word — belongs to the text, which is the only thing that can act on it.
 */
export function relaySectionKeys(doc: Document) {
  const view = doc.defaultView;
  if (!view || relayedKeys.has(view)) return;
  relayedKeys.add(view);
  view.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const { key } = event;
    if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight") {
      return;
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/**
 * Whether a fragment is *on the page the reader is reading*, across the page.
 *
 * The reading area shows one page, and the pages around it are in the document
 * too — mounted, laid out, and out of sight because they are clipped by the box
 * they sit in:
 *
 * - a paginated book keeps the page it is not showing flush against the area's
 *   edge, a fraction of a pixel in;
 * - a column strip that has not caught up with the pane's new width puts a whole
 *   column of itself inside the area — what showing, hiding or collapsing the
 *   sidebar (and fullscreen, which moves the pane's own edges) does, since each
 *   of them re-lays the page out under the ruler, the spring pinning the old
 *   width until it lets go.
 *
 * Neither is part of what the reader is looking at, and counting one drags the
 * band's edges clear of the text — the band ends up as wide as the *page*
 * instead of as wide as the words, so it reads as if it had faded out into the
 * margin, and it goes on reading that way until something else moves the ruler.
 *
 * The test is how much of the fragment is inside: more than half of it. A line
 * of the page being read is inside by construction (a hanging one included); a
 * fragment flush against the edge has essentially none of itself in the area,
 * and a stale page or column shows only a fraction of itself there.
 */
export function onPage(rect: RulerRect, vertical: boolean, from: number, to: number): boolean {
  const lo = vertical ? rect.top : rect.left;
  const hi = vertical ? rect.bottom : rect.right;
  return Math.min(hi, to) - Math.max(lo, from) > (hi - lo) / 2;
}

/**
 * Where the text sits across the page: its outermost edges, or `null` when
 * there is nothing to measure.
 *
 * The outermost, not the typical: the band has to cover every line it is drawn
 * over, and a band sized to the middle of the edges would leave the wash cutting
 * into whichever lines reach further — a dialogue line that hangs left, the last
 * line of a paragraph. What keeps the band honest against a page next door, and
 * against a page nobody can see, is `onPage` above and `lineRects` below: the
 * first is a fragment's own coordinates, the second whether it is painted at all.
 */
export function crossExtentOf(
  rects: readonly RulerRect[],
  vertical: boolean,
): { from: number; to: number } | null {
  if (rects.length === 0) return null;
  let from = Infinity;
  let to = -Infinity;
  for (const rect of rects) {
    from = Math.min(from, vertical ? rect.top : rect.left);
    to = Math.max(to, vertical ? rect.bottom : rect.right);
  }
  return { from, to };
}

/**
 * Projects measured rects onto the reading axis.
 *
 * Horizontal type reads down the page, so the axis is `top`/`bottom`. Vertical
 * type reads leftward from the right edge, so the axis is the distance from
 * that edge — which is what makes "forward" mean the same thing in both modes.
 * `crossExtent` is the reading viewport's width, the edge the vertical axis is
 * measured from.
 */
export function toSpans(
  rects: readonly RulerRect[],
  vertical: boolean,
  crossExtent: number,
): RulerInterval[] {
  return rects
    .map((rect) =>
      vertical
        ? { start: crossExtent - rect.right, end: crossExtent - rect.left }
        : { start: rect.top, end: rect.bottom },
    )
    .filter((span) => span.end - span.start > 0);
}

/**
 * Collapses a page's worth of spans into the lines they sit on.
 *
 * Every fragment of a text node reports its own rect, so one line of prose is
 * several — one per inline run, one per wrapped word — and they have to become
 * one interval, or the band would land on a *fragment* and span a third of the
 * line. Fragments of one line are the same band of leading, so they overlap
 * almost entirely, while consecutive lines merely abut: a fraction of the
 * shorter span separates the two cases with no magic constant, and a sub-pixel
 * overlap from a fractional line height is not mistaken for it.
 *
 * That also folds away the taller inline run — a footnote marker or a larger
 * glyph reports a taller rect than the line it sits on — which would otherwise
 * be counted as a line of its own and push every following line down one.
 */
export function toLines(spans: readonly RulerInterval[]): RulerInterval[] {
  const sorted = spans.toSorted((a, b) => a.start - b.start);
  const lines: RulerInterval[] = [];
  for (const span of sorted) {
    const last = lines[lines.length - 1];
    if (last) {
      const overlap = last.end - span.start;
      const shorter = Math.min(last.end - last.start, span.end - span.start);
      if (overlap > shorter / 2) {
        last.end = Math.max(last.end, span.end);
        continue;
      }
    }
    lines.push({ ...span });
  }
  return lines;
}

/**
 * Splits a page's fragments into columns, and each column's into lines.
 *
 * The column boundaries are arithmetic — the renderer lays columns out at even
 * pitches, and `count` is what it says it is rendering — but the lines are not:
 * each column's are measured on their own, so a paragraph that breaks at a
 * different place in each column stays two paragraphs. Only the fragments
 * actually on screen take part: a paginated section is one long strip shown
 * through a moving window, so the columns off the edge arrive as rects far
 * outside the reading area, and they would otherwise be bucketed into the two
 * that are on screen and bring a chapter's worth of lines with them.
 *
 * `from`/`to` are the cross-axis window (the reading area's own x range, for
 * horizontal type); a fragment counts when it overlaps it at all, for the same
 * reason `visibleLines` keeps a half-shown line.
 */
export function toColumns(
  rects: readonly RulerRect[],
  count: number,
  from: number,
  to: number,
): RulerColumn[] {
  const columns = Math.max(1, Math.floor(count));
  if (columns < 2 || to <= from) return [];
  const pitch = (to - from) / columns;
  const buckets: RulerRect[][] = Array.from({ length: columns }, () => []);
  for (const rect of rects) {
    // A fragment counts when it is on this page: the page next door sits flush
    // against the edge and a stale column straddles it (see `onPage`).
    if (!onPage(rect, false, from, to)) continue;
    const centre = (rect.left + rect.right) / 2;
    const index = Math.min(columns - 1, Math.max(0, Math.floor((centre - from) / pitch)));
    buckets[index]!.push(rect);
  }
  const result: RulerColumn[] = [];
  for (const bucket of buckets) {
    const lines = toLines(toSpans(bucket, false, 0));
    const extent = crossExtentOf(bucket, false);
    if (lines.length === 0 || !extent) continue;
    result.push({ left: extent.from, right: extent.to, lines });
  }
  return result;
}

/**
 * The lines the reader can actually see, given the reading area's own extent
 * along the axis.
 *
 * A document holds far more text than the page shows: a paginated section is
 * one long strip behind a moving window, and a scrolled chapter is a column of
 * lines running off both edges — measured as they come, most of them are
 * nowhere near the band, and the near ones are not necessarily the right ones,
 * because an off-screen line between two visible ones still wins on distance.
 * Worse, a chapter scrolled past its own start measures *entirely* above the
 * page, so without this there is nothing left to snap to and the band falls
 * back to arithmetic.
 *
 * A line counts when it overlaps the window at all, because a line half off the
 * top of the page is still the line the reader is looking at.
 */
export function visibleLines(
  lines: readonly RulerInterval[],
  from: number,
  to: number,
): RulerInterval[] {
  return lines.filter((line) => line.end > from && line.start < to);
}

/**
 * The block of `count` whole lines that starts at the line holding `anchor` —
 * that line, then the ones after it — or `null` when no line is near enough to
 * claim.
 *
 * The anchor is the leading edge of where the band is wanted, not its centre:
 * the block runs on from where the reader is. (Centring the block on the anchor
 * instead would cut the first and last lines in half.)
 *
 * The nearest line is accepted within half a line's leading, because the anchor
 * spends its life between lines — that is what leading is — and a band that
 * vanished whenever it sat in a paragraph gap would blink its way down the page.
 * Past that the anchor is in some other region of the page (a figure, the
 * margin) and the caller falls back to arithmetic.
 */
export function blockAt(
  lines: readonly RulerInterval[],
  anchor: number,
  count: number,
): RulerInterval | null {
  if (lines.length === 0) return null;
  const wanted = Math.max(1, Math.floor(count));
  let index = lines.findIndex((line) => anchor >= line.start && anchor <= line.end);
  if (index === -1) {
    const reach = medianAdvance(lines) / 2;
    let bestDistance = Infinity;
    lines.forEach((line, i) => {
      const distance = anchor < line.start ? line.start - anchor : anchor - line.end;
      if (distance < bestDistance) {
        bestDistance = distance;
        index = i;
      }
    });
    if (index === -1 || bestDistance > reach) return null;
  }
  return blockOf(lines, index, index + wanted - 1);
}

/**
 * The next block of `count` lines past `from` (forward) or before it
 * (backward), or `null` when there is no such block — which is how the caller
 * learns that the page is over and the turn begins.
 *
 * `from` is the *block* the band currently covers, without its padding: forward
 * starts at the first line that begins at or after the block's end, so one step
 * is exactly one block and never the line the band is already on. `eps` allows
 * for the fractional line heights that put a line's reported start a hair
 * inside the previous line's end.
 */
export function nextBlock(
  lines: readonly RulerInterval[],
  from: RulerInterval,
  count: number,
  direction: 1 | -1,
): RulerInterval | null {
  if (lines.length === 0) return null;
  const wanted = Math.max(1, Math.floor(count));
  const eps = medianExtent(lines) * RULER_PAD_FACTOR;

  if (direction === 1) {
    const start = lines.findIndex((line) => line.start >= from.end - eps);
    if (start === -1) return null;
    return blockOf(lines, start, Math.min(start + wanted - 1, lines.length - 1));
  }

  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i]?.end ?? Infinity) <= from.start + eps) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return blockOf(lines, Math.max(end - wanted + 1, 0), end);
}

/**
 * The same step, but across the columns of a spread: within the active column
 * while it lasts, then into the first (forward) or last (backward) block of the
 * next one. `null` past the last column — the page is over, and the caller
 * turns it.
 */
export function nextColumnBlock(
  columns: readonly RulerColumn[],
  index: number,
  from: RulerInterval,
  count: number,
  direction: 1 | -1,
): { index: number; block: RulerInterval } | null {
  if (columns.length === 0) return null;
  const active = Math.min(Math.max(index, 0), columns.length - 1);
  const column = columns[active];
  if (!column) return null;

  const within = nextBlock(column.lines, from, count, direction);
  if (within) return { index: active, block: within };

  for (let next = active + direction; next >= 0 && next < columns.length; next += direction) {
    // The far end of a column the reader has just stepped into: the top of the
    // next one going forward, the bottom of it going back.
    const edge: RulerInterval =
      direction === 1 ? { start: -Infinity, end: -Infinity } : { start: Infinity, end: Infinity };
    const block = nextBlock(columns[next]!.lines, edge, count, direction);
    if (block) return { index: next, block };
  }
  return null;
}

/**
 * The band around a block: the block itself plus symmetric padding, capped at
 * `count + 1` lines so a tall element inside it — a full-page image, a table —
 * cannot blow the band up to cover everything on the page.
 *
 * The padding is a fraction of the page's **own** leading, not of the `pitch` the
 * caller was configured with. Those are the same number only while the reader
 * owns the line height; 使用书籍排版 hands the book's own paragraph styles back,
 * so the page's real advance is whatever the book set and the configured pitch is
 * fiction. Measured on a real book (18px type): the page advanced 21.6px a line
 * while the ruler was padding by 10px — 46% of a line, not the intended 30% —
 * and the band came out 66.6px over 46.6px of words, thick enough to reach into
 * the line above and the line below. Padding off the measured advance is right
 * in both cases and needs no setting threaded through, so `pitch` is only the
 * fallback for a page with too few lines to measure.
 */
export function bandOver(
  block: RulerInterval,
  pitch: number,
  count: number,
  lines?: readonly RulerInterval[],
): RulerInterval {
  const lead = lines && lines.length >= 2 ? medianAdvance(lines) : pitch;
  const cap = lead * (Math.max(1, Math.floor(count)) + 1);
  // Three tenths of a line, but never more than the whitespace there is.
  //
  // The fraction is of the *advance*, and the advance and the glyph box are two
  // different measurements: a line box is as tall as the font's own height, while
  // the advance is how far the page steps. Where the book sets a leading tighter
  // than the type is high — perfectly legal, and what 使用书籍排版 hands back — the
  // line boxes *overlap* and consecutive lines have no whitespace between them at
  // all, so any padding reaches into the neighbouring line. Measured on a real
  // book (《认识世界》, 18px type, 跟随书籍): the page advanced 21.6px a line while
  // each line's box was 25px tall, leaving -3.4px between lines, and the ruler
  // padded 6px at each end regardless — so each edge sat 6.0px past the block's
  // own line, inside the line above or below it, which is the whole of
  // 「上下均超出了一些」. The same page under 自定义 advances 32.4px and has 7.4px
  // of real whitespace, and the same arithmetic reached 2.6px in — close enough
  // that it read as correct, which is why only the tight book was reported.
  //
  // So the padding is bounded by the gap the block actually has to the line
  // next to it: taking the whole of it is what "not reaching in" means, and a
  // line box carries air of its own around its glyphs, so an edge resting on the
  // neighbouring box is still clear of that line's letters.
  const wanted = Math.round(lead * RULER_PAD_FACTOR);
  const pad = lines && lines.length >= 2 ? Math.min(wanted, airAround(block, lines)) : wanted;
  // From the block's own leading edge, not centred on it. A block is a run of
  // lines, and on a page whose lines are sparse — a chapter title centred in
  // three-quarters of a blank page, a section opening, a figure with a caption
  // far below — the block spans gaps far taller than its own leading, so its
  // centre is usually *between* two lines: centring there drew the band on
  // empty paper, hundreds of pixels below the words it was supposed to mark, and
  // as wide as the whole block besides. Anchored at the front edge, the band
  // covers the lines the block is made of, which is what it is for.
  const start = block.start - pad;
  return { start, end: Math.min(start + cap, block.end + pad) };
}

/**
 * The whitespace between `block` and the line next to it — the most padding a
 * band can take without reaching into a line it is not marking.
 *
 * Every other line counts, and each one's gap is measured on whichever side of
 * the block it falls: a line above ends short of `block.start` by so much, a line
 * below starts after `block.end` by so much. Both can come out **negative**, and
 * that is the case this exists for. A book whose leading is tighter than its own
 * type is high has line boxes that overlap, so a neighbour is neither wholly
 * above nor wholly below the block — it reaches into it. Asking "how far is the
 * line above" cannot see that, because there is no line wholly above; the answer
 * is a negative number, and the band takes none.
 *
 * Measured on the block's own edges rather than on the page's leading, because
 * the two differ exactly where it matters: a paragraph's last line is followed by
 * a paragraph gap, not by another step, so the block can have far more room on
 * one side than a step's worth and no room at all on the other. The nearest side
 * decides, which is the only one the band's edges are actually standing in.
 */
function airAround(block: RulerInterval, lines: readonly RulerInterval[]): number {
  let air = Infinity;
  for (const line of lines) {
    // The block's own lines are the band, not a neighbour of it.
    if (line.start >= block.start && line.end <= block.end) continue;
    const gap = line.start < block.start ? block.start - line.end : line.start - block.end;
    air = Math.min(air, gap);
  }
  // No other line on the page: a block alone in a window has the whole of it.
  return Number.isFinite(air) ? Math.max(0, air) : Infinity;
}

/**
 * The band without a line to sit on: `count` lines of the reader's own leading,
 * centred on the anchor. A figure, a PDF page, a section whose text has not
 * painted yet — the band still marks a place, it just cannot name the line.
 */
export function fallbackBand(anchor: number, pitch: number, count: number): RulerInterval {
  const extent = pitch * Math.max(1, Math.floor(count));
  return { start: anchor - extent / 2, end: anchor + extent / 2 };
}

/**
 * Keeps the whole band inside the reading area, given where it would otherwise
 * centre. `extent` is the band's own thickness along the axis, which is what
 * puts the first and last line of the page out of reach of the band's edges —
 * the same rule the reference clamps with.
 */
export function clampAnchor(anchor: number, extent: number, min: number, max: number): number {
  if (max - min <= extent) return (min + max) / 2;
  const half = extent / 2;
  return Math.min(Math.max(anchor, min + half), max - half);
}

/**
 * The middle length of a set of lines — the page's glyph box, robustly. Used for
 * the band's padding and its stepping epsilon, not for its reach; see
 * `medianAdvance`.
 */
function medianExtent(lines: readonly RulerInterval[]): number {
  if (lines.length === 0) return 0;
  const extents = lines.map((line) => line.end - line.start).toSorted((a, b) => a - b);
  return extents[Math.floor(extents.length / 2)] ?? 0;
}

/**
 * The page's leading as a *step*: the typical distance from one line to the
 * next, which is what says how far from a line the anchor can be and still be on
 * it.
 *
 * The glyph box is not that distance. A line box reports the inline box — the
 * font's own height — while the page sets it at one-and-a-half leading or more,
 * so the boxes are separated by a real gap, and a paragraph gap is wider still.
 * Measured against the box, an anchor sitting in that gap is "nowhere near a
 * line" and the band drops to arithmetic on a page of perfectly ordinary prose:
 * on the prose path that made a two-line band four lines thick. Measured against
 * the step, the anchor is inside the leading that belongs to the line below it,
 * which is exactly where it is.
 */
function medianAdvance(lines: readonly RulerInterval[]): number {
  if (lines.length < 2) return medianExtent(lines);
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const step = lines[i]!.start - lines[i - 1]!.start;
    if (step > 0) steps.push(step);
  }
  if (steps.length === 0) return medianExtent(lines);
  return steps.toSorted((a, b) => a - b)[Math.floor(steps.length / 2)] ?? medianExtent(lines);
}

/**
 * A section's whole text can be a few hundred nodes, and this runs on every page
 * turn, so the walk is bounded. Nothing in a real book gets near it; it is here
 * so that a pathological section cannot turn a page turn into a stall.
 */
const MAX_RECTS = 4000;

/**
 * Whether an element is out of sight — `display: none`, `visibility: hidden`,
 * `opacity: 0` — in which case its text has a box and nothing to show.
 *
 * `checkVisibility` is the platform's own answer and knows every way an element
 * can be hidden; where it is missing, a box is taken at face value.
 */
function outOfSight(el: Element | null): boolean {
  return el?.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false;
}

/**
 * Every line of type in `doc`, in that document's own client coordinates,
 * shifted by `dx`/`dy` when it has to be (a section is an iframe, and a rect
 * inside it says nothing about where the section sits on the reader's screen),
 * and cut down to `clip` — the box the renderer actually paints it inside.
 *
 * Only what the reader can actually see is measured, and that is the whole point
 * of the door: a book that carries text nobody sees — a print-only running head,
 * a sprite's alt line, a helper span with no line height — has boxes for it all
 * the same, as wide as the page's content and as high as nothing, and a rect is
 * all the ruler knows how to read. Measured on a real book, one of those was the
 * widest thing in the section, and the band came out 13–29% of the window wider
 * than the words in every state that resizes the pane. Neither the reading area's
 * own coordinates nor the page's own frame can tell such a fragment from text:
 * it is inside both.
 *
 * `clip` is the other half of "can be seen", and it is the half that has to be
 * asked of the renderer. A paginated section is one long strip of pages inside a
 * single iframe, and the paginator clips it to the page the reader is on — a box
 * *narrower than the reading pane*, because the pane keeps an outer margin on
 * each side. So the page next door is not flush against the pane's edge with
 * none of itself inside (which is what `onPage` refuses); it starts inside the
 * pane's margin, and its first line of text is a fragment a couple of hundred
 * pixels long that clears the "more than half inside" test. Nothing paints it —
 * the page box is `overflow: hidden` — and the band's cross extent is the union
 * of the lines it washes, so that one phantom line dragged the band's right edge
 * out to the pane's own edge. Measured: the band 929px wide on 672px of words,
 * and the phantom was a `P` 162px wide sitting 79px outside the page box.
 *
 * So each rect is cut to the clip and dropped when nothing is left — the
 * platform's own notion of what reaches the reader, and the only one that
 * survives the page being re-laid out at a new width.
 *
 * `root` narrows the walk to the book's own text. On the prose path the reading
 * area holds chrome as well — the ruler would otherwise measure the header and
 * the page indicator and park the band on them.
 */
export function lineRects(
  doc: Document,
  root: Element | null,
  dx = 0,
  dy = 0,
  clip?: RulerRect | null,
): RulerRect[] {
  const scope = root ?? doc.body;
  if (!scope) return [];
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  const rects: RulerRect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    if (outOfSight(node.parentElement)) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      // A box with no extent is no line: it cannot be read, stepped over, or
      // landed on, and `toSpans` drops it for the axis — but its width across
      // the page would still count towards where the text is.
      if (rect.width <= 0 || rect.height <= 0) continue;
      // The clip is in the *host's* coordinates and a rect inside an iframe is
      // not, so the cut happens after the shift — the one place where both
      // frames are the same.
      const left = Math.max(rect.left + dx, clip ? clip.left : -Infinity);
      const right = Math.min(rect.right + dx, clip ? clip.right : Infinity);
      if (right <= left) continue;
      rects.push({
        top: rect.top + dy,
        bottom: rect.bottom + dy,
        left,
        right,
      });
      if (rects.length >= MAX_RECTS) return rects;
    }
  }
  return rects;
}

/** Lines `first`..`last` as one interval, or `null` when that is no lines. */
function blockOf(
  lines: readonly RulerInterval[],
  first: number,
  last: number,
): RulerInterval | null {
  const start = lines[first];
  const end = lines[last];
  if (!start || !end) return null;
  return { start: start.start, end: end.end };
}
