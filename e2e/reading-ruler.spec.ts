import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * The reading ruler: a band over a block of real lines, with everything outside
 * it washed toward the paper.
 *
 * The band is a *window cut in the page*, not a strip laid over one, and it is
 * sized to the lines it covers rather than to an arithmetic offset — so the
 * assertions here are geometry, measured off the page rather than pinned:
 * WebKit lays the same Chinese text out differently from Chromium, so a
 * hardcoded band height would only be pinning the engine. What is asserted is
 * the shape of the thing:
 *
 * 1. the band and the four washes tile the reading area exactly — nothing
 *    outside the band is left at full contrast, and the band is rounded;
 * 2. its thickness follows the reader's line count;
 * 3. it lands on whole lines, and lands on whole lines again after a page turn
 *    (the foliate path is the one that has to be asked where its lines are);
 * 4. dragging it moves it, follows the hand, and the place is remembered;
 * 5. the colour and the opacity reach the pixels;
 * 6. vertical type stands the band up;
 * 7. on a spread it covers *one* column, and the other one is washed with the
 *    rest of the page;
 * 8. an arrow key steps it a whole block at a time, and the step is a move
 *    rather than a jump.
 *
 * The line boxes are read straight out of the page — for a foliate book through
 * `foliate-view`'s shadow DOM, which is where the section iframe lives. That is
 * the same reading the ruler itself makes, deliberately: what no unit test can
 * see is whether the ruler got the *sections'* geometry and not some other
 * document's, and this is what checks that it did.
 */

/** One line of type: its extent along the reading axis, and across it. */
type Interval = { start: number; end: number; left: number; right: number };

/** A line as it is read off the page, with or without its cross-axis extent. */
type Span = { start: number; end: number };

/** A rectangle in window coords. */
type Box = { top: number; bottom: number; left: number; right: number };

/** One painted region of the ruler. */
type Painted = { box: Box; opacity: string; background: string };

/** What the ruler has drawn, read off the live DOM. */
type Drawn = {
  host: Box;
  band: Box;
  vertical: boolean;
  fill: string;
  radius: string;
  borders: string[];
  before: Painted;
  after: Painted;
  leading: Painted;
  trailing: Painted;
};

/** The box of every part of the ruler, with its paint. */
const DRAWN = `(() => {
  const host = document.querySelector("[data-reading-viewport]");
  const band = document.querySelector("[data-ruler-band]");
  const washOf = (name) => document.querySelector('[data-ruler-wash="' + name + '"]');
  const before = washOf("before");
  const after = washOf("after");
  const leading = washOf("leading");
  const trailing = washOf("trailing");
  if (!host || !band || !before || !after || !leading || !trailing) return null;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const paint = (el) => {
    const style = getComputedStyle(el);
    return { box: box(el), opacity: style.opacity, background: style.backgroundColor };
  };
  const bandBox = box(band);
  const style = getComputedStyle(band);
  return {
    host: box(host),
    band: bandBox,
    vertical: bandBox.bottom - bandBox.top > bandBox.right - bandBox.left,
    fill: style.backgroundColor,
    radius: style.borderTopLeftRadius,
    borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
    before: paint(before),
    after: paint(after),
    leading: paint(leading),
    trailing: paint(trailing),
  };
})()`;

/**
 * The lines of type on screen, in window coordinates.
 *
 * A prose page is walked directly. A foliate book is not: its words are in a
 * section iframe inside the view's shadow DOM, so the walk goes through it and
 * converts with the frame's own box — which is what the ruler's measurement
 * does, and the point of doing it here too.
 *
 * Only what is *on screen* counts, which is the same window the ruler measures
 * through: a paged chapter is one long strip of pages behind a moving window, so
 * every page of it is in the document at once, and a line from the page next
 * door sits at a height the reader cannot see while landing squarely inside the
 * band's own range.
 *
 * Each line carries both its extents, because a spread's two columns have
 * disagreeing line grids and a line can only be told which column it belongs to
 * by where it is across the page.
 */
const LINES = `(() => {
  const host = document.querySelector("[data-reading-viewport]");
  const band = document.querySelector("[data-ruler-band]");
  const hostBox = host?.getBoundingClientRect();
  if (!hostBox) return [];
  const bandBox = band?.getBoundingClientRect();
  const vertical = !!bandBox && bandBox.height > bandBox.width;
  const intervals = [];
  const collect = (doc, dx, dy) => {
    const root = doc.querySelector("[data-reading-content]") ?? doc.body;
    if (!root) return;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const top = rect.top + dy;
        const bottom = rect.bottom + dy;
        const left = rect.left + dx;
        const right = rect.right + dx;
        // On the page being read, by the ruler's own rule: *across* the page a
        // fragment counts when more than half of it is inside the area — the
        // page next door sits flush against the edge, and a page laid out again
        // under the band can leave a column of itself straddling it, and neither
        // is this page's text. *Along* the axis, what the window reaches.
        const across = vertical
          ? [top, bottom, hostBox.top, hostBox.bottom]
          : [left, right, hostBox.left, hostBox.right];
        if (
          Math.min(across[1], across[3]) - Math.max(across[0], across[2]) <=
          (across[1] - across[0]) / 2
        ) {
          continue;
        }
        if (
          (vertical ? right - hostBox.left <= 1 || hostBox.right - left <= 1 : bottom - hostBox.top <= 1 || hostBox.bottom - top <= 1)
        ) {
          continue;
        }
        intervals.push({
          start: vertical ? hostBox.right - right : top,
          end: vertical ? hostBox.right - left : bottom,
          left: vertical ? top : left,
          right: vertical ? bottom : right,
        });
      }
    }
  };
  const view = document.querySelector("foliate-view");
  if (view?.shadowRoot) {
    const frames = view.shadowRoot
      .querySelector("foliate-paginator")
      ?.shadowRoot?.querySelectorAll("iframe");
    for (const frame of frames ?? []) {
      const doc = frame.contentDocument;
      const box = frame.getBoundingClientRect();
      if (!doc || box.width <= 0 || box.height <= 0) continue;
      collect(doc, box.left, box.top);
    }
  } else {
    collect(document, 0, 0);
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last) {
      const overlap = last.end - interval.start;
      const shorter = Math.min(last.end - last.start, interval.end - interval.start);
      if (overlap > shorter / 2) {
        last.end = Math.max(last.end, interval.end);
        last.left = Math.min(last.left, interval.left);
        last.right = Math.max(last.right, interval.right);
        continue;
      }
    }
    merged.push({ ...interval });
  }
  return merged;
})()`;

/**
 * The lines of one column of a spread, in window coordinates.
 *
 * A prose page's words are in this document, so this walks it directly. The
 * column has to be picked *before* the fragments are merged: on a spread the two
 * columns' lines sit at the same heights, so merging first would read them as one
 * line spanning the gutter — which is the very thing the band must not do.
 *
 * Which column is by the reading area's own middle and not by the band: reading
 * the band's own range back to itself would assert nothing.
 */
const columnLines = (page: Page, side: -1 | 1) =>
  page.evaluate((sign: number) => {
    const host = document.querySelector("[data-reading-viewport]");
    const root = document.querySelector("[data-reading-content]");
    if (!host || !root) return [];
    const hostBox = host.getBoundingClientRect();
    const middle = (hostBox.left + hostBox.right) / 2;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const intervals: { start: number; end: number; left: number; right: number }[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        // On screen by more than a hair (the page next door sits flush against
        // the window), and on the side the band is reading.
        if (
          rect.right - hostBox.left <= 1 ||
          hostBox.right - rect.left <= 1 ||
          rect.bottom - hostBox.top <= 1 ||
          hostBox.bottom - rect.top <= 1
        ) {
          continue;
        }
        const centre = rect.left + rect.width / 2;
        if ((centre - middle) * sign <= 0) continue;
        intervals.push({ start: rect.top, end: rect.bottom, left: rect.left, right: rect.right });
      }
    }
    intervals.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number; left: number; right: number }[] = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (last) {
        const overlap = last.end - interval.start;
        const shorter = Math.min(last.end - last.start, interval.end - interval.start);
        if (overlap > shorter / 2) {
          last.end = Math.max(last.end, interval.end);
          last.left = Math.min(last.left, interval.left);
          last.right = Math.max(last.right, interval.right);
          continue;
        }
      }
      merged.push({ ...interval });
    }
    return merged;
  }, side);

/** A page's line pitch, taken from the lines themselves: the glyph box. */
function pitchOf(lines: readonly Span[]): number {
  const extents = lines.map((line) => line.end - line.start).toSorted((a, b) => a - b);
  return extents[Math.floor(extents.length / 2)]!;
}

/**
 * The page's line *advance*: the typical distance from one line to the next.
 *
 * Not the same as the pitch above, which is the glyph box. A page sets its lines
 * further apart than its letters are tall, so the step is the larger of the two
 * — and it is the one a step of the band has to be measured against.
 */
function advanceOf(lines: readonly Span[]): number {
  const steps = lines
    .slice(1)
    .map((line, i) => line.start - lines[i]!.start)
    .filter((step) => step > 0)
    .toSorted((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] ?? pitchOf(lines);
}

/** A box's extent along the reading axis. */
const along = (box: Box, vertical: boolean) =>
  vertical ? box.right - box.left : box.bottom - box.top;

/** …and across it, which is the page's width for horizontal type. */
const across = (box: Box, vertical: boolean) =>
  vertical ? box.bottom - box.top : box.right - box.left;

/**
 * The lines the band covers, and how far its own edges stand off theirs.
 *
 * Read by centres, which is the only reading that survives the padding: the band
 * is drawn a fixed distance *outside* the first and last line it covers, and
 * that distance is under half a line of leading, so a covered line's centre is
 * inside the band and its neighbour's is not. A band that fell back to
 * arithmetic has edges at arbitrary offsets instead — which is what a stand-off
 * beyond one line's leading is here to catch, since an arithmetic band is drawn
 * at the settings' leading and the page's own lines are the renderer's.
 *
 * Not "centred on the lines it covers": the band runs *from* the leading edge of
 * its block downwards, and a block on a sparse page — a chapter title centred in
 * three-quarters of a blank page, a section opening — is far taller than the
 * lines the band is asked to cover. Centring on the block's middle put the band
 * in the gap between two lines, on blank paper, hundreds of pixels from the words
 * it was marking. What has to hold is the stand-off at each end.
 */
function coveredLines<T extends Span>(drawn: Drawn, lines: readonly T[], label = "") {
  const vertical = drawn.vertical;
  const low = vertical ? drawn.band.left : drawn.band.top;
  const high = vertical ? drawn.band.right : drawn.band.bottom;
  const covered = lines.filter((line) => {
    const centre = (line.start + line.end) / 2;
    return centre > low && centre < high;
  });
  expect(covered.length, `${label}带没有盖住任何一行`).toBeGreaterThan(0);

  const lead = advanceOf(lines);
  const head = covered[0]!.start - low;
  const tail = high - covered.at(-1)!.end;
  expect(head, `${label}带的上边离第一行太远`).toBeLessThan(lead);
  expect(tail, `${label}带的下边离最后一行太远`).toBeLessThan(lead);
  // …and it hugs them: the band's own thickness is the lines it covers plus a
  // stand-off at each end, so a band drawn well past them — on a figure, on the
  // gap between two paragraphs, on the page's own width — is caught here too.
  const thickness = covered.at(-1)!.end - covered[0]!.start;
  expect(
    high - low - thickness,
    `${label}带比它盖住的那些行厚出一截（它罩住了行与行之间的空白）`,
  ).toBeLessThan(lead * 2);

  return { count: covered.length, first: covered[0]!.start, covered };
}

/**
 * The band hugs the lines it covers, across the page.
 *
 * The extent the ruler draws to is those lines' own outermost edges, a pad
 * outside them; what it must never be is a strip across the whole window, nor
 * one that stops short of them — the first reads as a band fading out into the
 * margin, the second as a wash cutting into the words.
 *
 * Handed the lines the band *covers*, not every line on the page: the band is a
 * window on the block it is drawn on, so a longer line elsewhere on the page is
 * washed like the rest of the page and says nothing about the band's width. (It
 * used to be handed the whole page, and the width came from every fragment the
 * section holds — including boxes for text nobody can see, which on a real book
 * put the band 13–29% of the window wider than the words.)
 */
function hugsText(drawn: Drawn, lines: readonly Interval[], label = "") {
  const vertical = drawn.vertical;
  if (lines.length === 0) return;
  // `left`/`right` are the line's cross-axis extent in window coords in both
  // writing modes; `start`/`end` are the *reading* axis, which for vertical type
  // runs leftward and would compare apples to oranges here. The band's cross
  // extent runs the other way round: across the page for horizontal type, up and
  // down for vertical.
  const low = Math.min(...lines.map((line) => line.left));
  const high = Math.max(...lines.map((line) => line.right));
  const bandLow = vertical ? drawn.band.top : drawn.band.left;
  const bandHigh = vertical ? drawn.band.bottom : drawn.band.right;
  // The pad outside the text is a fraction of the reader's leading, which the
  // page's own advance approximates. Half the advance, not three tenths: the
  // band pads by 0.3 × the advance *it* measures, and with 使用书籍排版 the
  // page's steps are bimodal (行距 and 段距), so the two medians can land on
  // different modes and the two 0.3s disagree by a few pixels. Half an advance
  // still sits far under the failure this exists to catch — a band as wide as
  // the page instead of the words is tens of percent of the window.
  const pad = advanceOf(lines) * 0.5 + 2;
  expect(bandLow, `${label}带没有对齐正文的这一边`).toBeGreaterThanOrEqual(low - pad);
  expect(bandLow, `${label}带没有对齐正文的这一边`).toBeLessThanOrEqual(low + pad);
  expect(bandHigh, `${label}带没有对齐正文的那一边`).toBeGreaterThanOrEqual(high - pad);
  expect(bandHigh, `${label}带没有对齐正文的那一边`).toBeLessThanOrEqual(high + pad);
}

async function openBook(page: Page, query: string, title: RegExp) {
  await page.setViewportSize({ width: 1280, height: 820 });
  // Pinned rather than inherited: the ruler animates its step, and a machine
  // with reduce-motion on would turn the step into a jump and quietly hollow out
  // the test that says it animates.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(query);
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(900);
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
}

/** The settings drawer's 「阅读标尺」 group. Assumes the drawer is open. */
const rulerGroup = (page: Page) =>
  page
    .locator("aside div")
    .filter({ has: page.getByText("阅读标尺", { exact: true }) })
    .last();

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
}

/**
 * Presses one chip in the settings drawer, opening and closing it around the
 * press.
 *
 * By label rather than by the group it sits in: these labels are unique among the
 * chips, and the groups are what move when the drawer is reordered.
 */
async function choose(page: Page, label: string) {
  await openSettings(page);
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(400);
  await closeSettings(page);
}

/** Turns the ruler on and leaves the drawer closed. */
async function enableRuler(page: Page) {
  await openSettings(page);
  await rulerGroup(page).getByRole("button", { name: "开启", exact: true }).click();
  await page.waitForTimeout(400);
  await closeSettings(page);
}

/**
 * What the ruler has drawn, read once it has stopped moving.
 *
 * A read can land while the band is still in flight: a step's own transition, a
 * re-measure after the drawer closes and the one that follows a page turn are
 * all still running when a `waitForTimeout` expires on a loaded runner, and a
 * moving box is exactly how a geometry assertion flakes. So the picture is taken
 * until two of them agree — not a frame count, which is the other way a suite
 * like this gets flaky.
 */
async function rulerDrawn(page: Page): Promise<Drawn> {
  let last: Drawn | null = null;
  for (let i = 0; i < 16; i += 1) {
    const drawn = (await page.evaluate(DRAWN)) as Drawn | null;
    expect(drawn, "阅读标尺没有画出来").not.toBeNull();
    const still =
      last !== null &&
      Math.abs(last.band.top - drawn!.band.top) < 0.5 &&
      Math.abs(last.band.bottom - drawn!.band.bottom) < 0.5 &&
      Math.abs(last.band.left - drawn!.band.left) < 0.5 &&
      Math.abs(last.band.right - drawn!.band.right) < 0.5;
    last = drawn!;
    if (still) return drawn!;
    await page.waitForTimeout(60);
  }
  return last!;
}

/** How much of the reading area the parts add up to, along the reading axis. */
const spanAlong = (drawn: Drawn) =>
  along(drawn.before.box, drawn.vertical) +
  along(drawn.band, drawn.vertical) +
  along(drawn.after.box, drawn.vertical);

/** …and across it, which on a spread is the two columns and the gutter. */
const spanAcross = (drawn: Drawn) =>
  across(drawn.leading.box, drawn.vertical) +
  across(drawn.band, drawn.vertical) +
  across(drawn.trailing.box, drawn.vertical);

/** Whole-book progress, as the footer prints it — monotonic across chapters. */
async function progress(page: Page): Promise<number> {
  const text = await page.locator("[data-reader-progress]").first().innerText();
  return Number(text.replace("%", "").trim());
}

test("the band and its washes tile the reading area, at the parked fraction", async ({ page }) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await enableRuler(page);

  const drawn = await rulerDrawn(page);
  const height = drawn.host.bottom - drawn.host.top;
  const width = drawn.host.right - drawn.host.left;
  const bandTop = drawn.band.top - drawn.host.top;

  // A window, not a strip: the two washes along the axis plus the band are the
  // whole reading area, so nothing outside the band is left at full contrast.
  expect(bandTop, "带上面的遮罩没有盖住带以上的部分").toBeGreaterThan(0);
  expect(drawn.before.box.bottom, "带上面的遮罩没有盖住带以上的部分").toBeCloseTo(
    drawn.band.top,
    0,
  );
  expect(spanAlong(drawn), "带与上下遮罩加不满阅读区").toBeCloseTo(height, 0);
  // …and the same across the page, where the two washes are the slivers the
  // band's own inset leaves. An absolutely positioned box with one extent and no
  // other shrinks to nothing, so this is what says the four washes are four and
  // not two.
  expect(spanAcross(drawn), "带与左右遮罩加不满阅读区的宽度").toBeCloseTo(width, 0);
  expect(across(drawn.before.box, drawn.vertical), "带上下两块遮罩没有铺满页宽").toBeCloseTo(
    width,
    0,
  );

  // Parked at the fraction the settings hold (33). The band is centred on a
  // measured block rather than placed at that exact pixel, so this is the
  // neighbourhood of a third, not a third.
  const fraction = ((drawn.band.top + drawn.band.bottom) / 2 - drawn.host.top) / height;
  expect(fraction, "带没有停在三分之一处").toBeGreaterThan(0.22);
  expect(fraction, "带没有停在三分之一处").toBeLessThan(0.45);

  // The wash is the page's own colour, so the text fades toward the paper.
  expect(drawn.before.background, "遮罩不是页面底色").toBe(drawn.after.background);
  expect(Number(drawn.before.opacity), "不透明度没有反映到遮罩上").toBeCloseTo(0.5, 2);

  // Rounded, and rounded on the page's own scale rather than a hairline.
  expect(Number.parseFloat(drawn.radius), "带的角没有圆").toBeGreaterThanOrEqual(8);

  // And the band is as wide as the words it covers: a strip that runs on past
  // the text into the margins reads as if it had faded out before and after the
  // lines it marks.
  const lines = (await page.evaluate(LINES)) as Interval[];
  expect(lines.length, "一个行盒都没量到").toBeGreaterThan(3);
  hugsText(drawn, coveredLines(drawn, lines).covered);
});

test("the band's thickness follows the reader's line count", async ({ page }) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await enableRuler(page);

  const setLines = async (value: string) => {
    await openSettings(page);
    await rulerGroup(page).getByRole("slider", { name: "突出显示行数微调" }).fill(value);
    await page.waitForTimeout(400);
    await closeSettings(page);
    return rulerDrawn(page);
  };
  const two = await setLines("2");
  const four = await setLines("4");

  const lines = (await page.evaluate(LINES)) as Interval[];
  expect(lines.length, "一个行盒都没量到").toBeGreaterThan(3);

  // Counted, not measured: two lines asked for is two lines covered. A band that
  // fell back to arithmetic would cover some other number — it would be drawn at
  // the settings' leading while these lines are the renderer's.
  expect(coveredLines(two, lines).count, "设置两行时带覆盖的行数不对").toBe(2);
  expect(coveredLines(four, lines).count, "设置四行时带覆盖的行数不对").toBe(4);
});

test("a page with no words on it gets no band", async ({ page }) => {
  // A plate, a cover, a full-page diagram: there is nothing on the page for the
  // ruler to point at, and a band drawn anyway is a large empty rounded
  // rectangle floating on blank paper. That is not a cosmetic difference — the
  // reader sees a shape where there is no text and reads it as "it selected an
  // empty thing".
  //
  // Distinct from *a line near where the band wants to be* (a paragraph gap, a
  // figure, the lines just off the top of the window), which still gets an
  // arithmetic band: that one marks a real place on a page that has text.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  // `enableRuler` waits for the band, which a wordless page never grows — so the
  // switch is thrown here and the assertions below read the page as it is.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await rulerGroup(page).getByRole("button", { name: "开启", exact: true }).click();
  await page.waitForTimeout(400);
  await closeSettings(page);
  await page.waitForTimeout(1200);

  // The fixture opens on its plate: no text at all.
  const lines = (await page.evaluate(LINES)) as Interval[];
  expect(lines.filter((l) => l.start >= 0).length, "插图页上竟然量到了行").toBe(0);
  await expect(
    page.locator("[data-ruler-band]"),
    "无字页上画了带子（一个挂在空白上的空框）",
  ).toHaveCount(0);

  // And the washes go with it: there is no block of text for them to be outside.
  await expect(page.locator('[data-ruler-wash="after"]')).toHaveCount(0);

  // Turn on, and the band comes back with the words.
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);
  const drawn = await rulerDrawn(page);
  const prose = (await page.evaluate(LINES)) as Interval[];
  const covered = prose.filter((line) => {
    const centre = (line.start + line.end) / 2;
    return centre > drawn.band.top && centre < drawn.band.bottom;
  });
  expect(covered.length, "翻到有字的页后带子仍然没落在任何一行上").toBe(1);
  hugsText(drawn, covered);
});

test("the band lands on the words, not the gap above them, on a chapter opener", async ({
  page,
}) => {
  // Every fixture in this suite is dense, evenly leaded prose, where a block of
  // lines is barely taller than the band drawn over it — so a band centred on
  // the block and a band running from its leading edge look the same, and the
  // difference went unnoticed for three rounds of "fixed".
  //
  // A chapter opener is not like that. Its title is centred in three-quarters of
  // a blank page, and the first paragraph sits hundreds of pixels below it, so
  // the block that holds both is far taller than the band. Centred on the
  // block, the band lands in the gap between the two lines: on blank paper,
  // below the title it was marking, and — taking its width from the whole block
  // rather than the lines it washes — as wide as the page. Measured on a real
  // book: a 576px band with nothing at all under it.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);
  // The fixture opens on its plate (a page with no text at all — see the case
  // above). The opener is the next one.
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);

  /** The lines the band is on, and the width it drew itself to match them. */
  const on = async (label = "") => {
    const band = await rulerDrawn(page);
    const lines = (await page.evaluate(LINES)) as Interval[];
    expect(lines.length, `${label}标题页一个字的行盒都没量到`).toBeGreaterThan(0);
    const covered = lines.filter((line) => {
      const centre = (line.start + line.end) / 2;
      return centre > band.band.top && centre < band.band.bottom;
    });
    // On a line at all, which is the half that was broken: the band covered a
    // stretch of page with no text anywhere in it.
    expect(covered.length, `${label}带子底下没有一行字（它落在标题与正文之间的空白上了）`).toBe(1);
    // And as wide as the words it is on — the title, not the paragraphs far
    // below it that share the block.
    hugsText(band, covered, `${label}：`);
  };

  await on();
  // And it stays on it when the pane changes width: the block is re-derived,
  // and a band centred on a block that tall lands in the gap again.
  for (const label of ["折叠侧边栏", "全屏阅读"]) {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForTimeout(2600);
    await on(`${label}：`);
  }
});

test("no screen in the book leaves the band floating where there is no line", async ({ page }) => {
  // The one assertion that covers the report as a whole rather than one state:
  // walk the book, and at every screen the band is either on a line and as wide
  // as it, or not drawn at all. There is no third answer.
  //
  // A paged book hands this more states than a reader visits on purpose: every
  // section boundary is a screen whose window reaches no line at all, and the
  // section that arrives is mounted *outside* it (measured: the frame sitting
  // 9,000–116,000px above the window). A band sized from a fragment like that
  // is a wide empty rectangle on blank paper — the "it selected an empty thing"
  // report — and a per-state check never sees it, because each state is
  // checked on a page that happens to have words on it.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await rulerGroup(page).getByRole("button", { name: "开启", exact: true }).click();
  await page.waitForTimeout(400);
  await closeSettings(page);
  await page.waitForTimeout(1200);

  /** `on a line` | `not drawn` — and which of the two, with the numbers. */
  const verdict = async () =>
    (await page.evaluate(() => {
      const host = document.querySelector("[data-reading-viewport]")!.getBoundingClientRect();
      const bandEl = document.querySelector("[data-ruler-band]");
      const spans: { c: number; l: number; r: number }[] = [];
      for (const frame of document
        .querySelector("foliate-view")
        ?.shadowRoot?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelectorAll("iframe") ?? []) {
        const doc = frame.contentDocument;
        const fb = frame.getBoundingClientRect();
        if (!doc?.body || fb.width <= 0) continue;
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        const range = doc.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            if (r.width <= 0 || r.height <= 0) continue;
            const l = r.left + fb.left - host.left;
            const right = r.right + fb.left - host.left;
            if (Math.min(right, host.width) - Math.max(l, 0) <= (right - l) / 2) continue;
            spans.push({ c: (r.top + r.bottom) / 2 + fb.top - host.top, l, r: right });
          }
        }
      }
      if (!bandEl)
        return { state: "none", nWin: spans.filter((s) => s.c >= 0 && s.c < host.height).length };
      const b = bandEl.getBoundingClientRect();
      const covered = spans.filter(
        (s) => s.c > b.top - host.top + 1 && s.c < b.bottom - host.top - 1,
      );
      if (covered.length === 0) {
        return { state: "adrift", nWin: spans.filter((s) => s.c >= 0 && s.c < host.height).length };
      }
      const lo = Math.min(...covered.map((s) => s.l));
      const hi = Math.max(...covered.map((s) => s.r));
      return {
        state: "on a line",
        nWin: spans.filter((s) => s.c >= 0 && s.c < host.height).length,
        slack: Math.min(Math.abs(b.left - host.left - lo), Math.abs(hi - (b.right - host.left))),
      };
    })) as { state: string; nWin: number; slack?: number };

  const tally = { onALine: 0, none: 0 };
  for (let screen = 0; screen < 12; screen += 1) {
    const v = await verdict();
    expect(v.state, `第 ${screen} 屏：带子浮在没有一行字的地方`).not.toBe("adrift");
    if (v.state === "none") {
      tally.none += 1;
      // Nothing on the page to mark: a wordless screen draws no band at all.
      expect(v.nWin, `第 ${screen} 屏：屏内有 ${v.nWin} 行字，却没画带子`).toBe(0);
    } else {
      tally.onALine += 1;
      expect(v.slack, `第 ${screen} 屏：带子与它罩住的那些行差 ${v.slack}px`).toBeLessThan(16);
    }
    await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
    await page.waitForTimeout(1400);
  }
  // Both answers must actually occur, or this walked one kind of screen twice.
  expect(tally.onALine, "全程没有一屏带子落在字上，扫的不是正文").toBeGreaterThan(0);
  expect(tally.none, "全程没有一屏无字，扫的不是标题页/插图页").toBeGreaterThan(0);
});

test("the band's padding comes off the page's own leading, not the setting's", async ({ page }) => {
  // 使用书籍排版 hands the book back its own paragraph styles, so the page's line
  // height is whatever the book set and the reader's line-height setting says
  // nothing about it. The ruler padded the band by a fraction of the *configured*
  // leading anyway, so on a book set tighter than the setting the padding was a
  // larger fraction of a real line than the intended three tenths — and the band
  // reached past the words it was marking into the line above and the line below.
  //
  // Measured on a real book (《认识世界》, 18px type, 跟随书籍): the page advanced
  // 21.6px a line, the ruler padded by 10px — 46% of a line — and the band came
  // out 66.6px over 46.6px of words, three lines under a two-line setting. That
  // is the whole of 「没有适配」: the ruler was padding against a number that was
  // not on the screen. 🔴 The four guards already in `bandOver`'s path (outOfSight,
  // onPage, the placement key, crossOf) all passed here — they are about *which*
  // lines, and this was about how thick the band around them is.
  //
  // The fixture is the sparse-title book, and both of its shapes are load-bearing
  // here — 🔴 each was found by asking "can this slot tell the two paths apart?"
  // and getting the wrong answer first:
  //
  // - Its stylesheet sets `line-height: 1.2`, nowhere near a reader preset
  //   (1.6 / 1.8 / 2.0 / 2.2 → 28.8 / 32.4 / 36 / 39.6px at 18px), so the page's
  //   21.6px leading cannot be confused with the setting. It was **1.75** at
  //   first — 0.9px from the 1.8 preset — and the slot stayed green with the
  //   guard removed.
  // - Its paragraphs run to three or more lines, so a `rulerLines`-long block
  //   sits *inside* one and the padding is measurable beside it. At two lines the
  //   block was the whole paragraph, its extent already carried the 0.78em gap,
  //   and the padding was a rounding error — green again, for a different reason.
  //
  // The demo prose book was tried here too and cannot be used: it ships no
  // stylesheet, so 跟随书籍 leaves it on the browser's `normal` leading, which on
  // WebKit is an 18px advance against a 25.2px glyph box — the line boxes
  // *overlap*, which no real book sets and which makes "how many lines did the
  // band cover" meaningless.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  // Off the plate, onto the opener, and one page on to the prose: a leading is a
  // leading there, where it is not a chapter title's own (this book sets its h1
  // to 1.38).
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(1800);

  /**
   * The band's padding in the page's own units: how far it stands off the first
   * and last line it covers, over the distance from one line to the next. Three
   * tenths of a line is the design; what is caught here is a pad taken from a
   * leading that is not this page's.
   */
  const padding = async (label: string) => {
    const drawn = await rulerDrawn(page);
    const lines = (await page.evaluate(LINES)) as Interval[];
    expect(lines.length, `${label}：一个字的行盒都没量到`).toBeGreaterThan(3);
    const covered = lines.filter((line) => {
      const centre = (line.start + line.end) / 2;
      return centre > drawn.band.top && centre < drawn.band.bottom;
    });
    expect(covered.length, `${label}：带子底下没有一行字`).toBeGreaterThan(0);
    const lead = advanceOf(lines);
    return {
      lead,
      count: covered.length,
      head: (covered[0]!.start - drawn.band.top) / lead,
      tail: (drawn.band.bottom - covered.at(-1)!.end) / lead,
    };
  };

  /** 书籍排版 group, not 字体 — both carry a 跟随书籍 chip. */
  const typography = async (label: string) => {
    await openSettings(page);
    await page
      .locator("aside div")
      .filter({ has: page.getByText("书籍排版", { exact: true }) })
      .last()
      .getByRole("button", { name: label, exact: true })
      .click();
    await page.waitForTimeout(500);
    await closeSettings(page);
    // The setting re-opens the view, so the band is derived from scratch again.
    await page.waitForTimeout(1800);
  };

  await typography("跟随书籍");
  const follow = await padding("跟随书籍");
  // The page's own leading, and the band's own ends: three tenths of a line each,
  // give or take the rounding. A pad off the 1.8 preset on a page advancing 25px
  // is 0.4 of a line and lands here red.
  expect(follow.head, "跟随书籍：带的上边留白不是一个行距的三成").toBeLessThan(0.38);
  expect(follow.tail, "跟随书籍：带的下边留白不是一个行距的三成").toBeLessThan(0.38);
  // The over-padded band's other half: its extra reach swallows a third line.
  // (Under 自定义 the block can legitimately span a paragraph gap, which is its
  // own rule — so the count is only pinned where the block is intra-paragraph.)
  expect(follow.count, "跟随书籍：带子多罩了一行（padding 是按设置的行距算的）").toBe(2);

  // The same page with the reader owning the leading again: same words, same
  // settings, a different line height on the page. The band has to follow the
  // page, and the page's leading is now the larger of the two.
  await typography("自定义");
  const custom = await padding("自定义");
  expect(custom.lead, "自定义：页面的行距没有跟着设置走").toBeGreaterThan(follow.lead);
  expect(custom.head, "自定义：带的上边留白不是一个行距的三成").toBeLessThan(0.45);
  expect(custom.tail, "自定义：带的下边留白不是一个行距的三成").toBeLessThan(0.45);
});

test("the band's padding never outgrows the air between the lines", async ({ page }) => {
  // Three tenths of a line is a padding, not a distance. It only reads as
  // breathing room where there *is* room, and a page can have none: a book whose
  // leading is tighter than its own type is high has line boxes that overlap, so
  // two consecutive lines share a few pixels of box and there is no whitespace
  // between them at all. 使用书籍排版 hands exactly such a book back its own
  // paragraph styles.
  //
  // Measured on the book that reported it (《认识世界》, 18px type): under
  // 跟随书籍 the page advanced 21.6px a line while each line's box was 25px tall
  // — 3.4px of overlap — and the ruler padded 6px at each end regardless. The
  // band was 46.6px over 46.6px of words and its edges sat 6px *inside* the
  // neighbouring lines, which is the whole of 「上下均超出了一些」. The same page
  // under 自定义 advances 32.4px, leaves 7.4px of air, and the same arithmetic
  // reached 2.6px in — close enough to look right, which is why only the tight
  // book was reported and why this was read as 「跟随书籍坏了」 rather than as an
  // arithmetic that ignores its own inputs.
  //
  // The rule asserted is that the band never reaches further from the lines it
  // marks than the gap to the line it is *not* marking: reach <= air on each
  // side, and where the air is negative the only reach that satisfies it is none.
  // Stated as "clear of the neighbour" instead it would be unsatisfiable — the
  // neighbour's box already overlaps the marked line, so no edge position clears
  // it. What is both satisfiable and visible is not reaching *any further* in.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  // Onto the prose: the fixture's leading is 1.2, and its chapter opener sets
  // its own title's leading besides, so this is the page where a leading is a
  // leading.
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(1800);

  /** 书籍排版 group, not 字体 — both carry a 跟随书籍 chip. */
  const typography = async (label: string) => {
    await openSettings(page);
    await page
      .locator("aside div")
      .filter({ has: page.getByText("书籍排版", { exact: true }) })
      .last()
      .getByRole("button", { name: label, exact: true })
      .click();
    await page.waitForTimeout(500);
    await closeSettings(page);
    // The setting re-opens the view, so the band is derived from scratch again.
    await page.waitForTimeout(1800);
  };

  /**
   * How far the band's edges stand off the lines it marks, minus the air each
   * side actually has. Both must be <= 0.
   *
   * The band is walked down the page with the arrow keys rather than scrolled or
   * turned: a page turn hands the band to the arriving page's first block, and
   * the band is placed at the top of the area to begin with, so both leave it on
   * the page's first line — where there is no line above to overrun into and only
   * the tail side is ever scored.
   */
  const overreach = async (label: string) => {
    let worstHead = -Infinity;
    let worstTail = -Infinity;
    let headSides = 0;
    let tailSides = 0;
    // Four steps down and four back up — the band's interior positions and no
    // further. The walk is kept off both ends of the page deliberately: the first
    // and last blocks are the ones `clampAnchor` pulls against the reading area,
    // and a clamped edge sits wherever the area's edge is rather than where the
    // padding put it, so a score taken there measures the clamp. The padding is
    // the same at every position, and these are the positions where it is the
    // padding being measured.
    for (const key of [...Array(4).fill("ArrowDown"), ...Array(4).fill("ArrowUp")]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(450);
      // Read the band without insisting it is there: stepping off the end of a
      // page lands on a stretch with no lines in the window, and the band is then
      // deliberately not drawn (a page with no words gets no band). Such a step has
      // nothing to score, which is not a failure.
      const drawn = (await page.evaluate(DRAWN)) as Drawn | null;
      if (!drawn) continue;
      const lines = (await page.evaluate(LINES)) as Interval[];
      const { vertical, band, host } = drawn;
      const low = vertical ? band.left : band.top;
      const high = vertical ? band.right : band.bottom;
      const marked: number[] = [];
      lines.forEach((line, i) => {
        const centre = (line.start + line.end) / 2;
        if (centre > low && centre < high) marked.push(i);
      });
      if (marked.length === 0) continue;
      const first = marked[0]!;
      const last = marked[marked.length - 1]!;

      // A side is only scored when it has a neighbour to overrun into and the band
      // is not sitting against the reading area on it.
      //
      // No neighbour means the page's own edge — nothing to reach into, and
      // counting it would fold an infinity into the worst case and hide every
      // other screen. Against the area is `clampAnchor`'s doing and not the
      // padding's: a band that would hang off the area is pulled back inside it
      // whole, so that edge is wherever the area's edge is rather than where the
      // padding put it. Scored there, this measures the clamp and reports it as a
      // padding bug — and the walk reaches both ends of a page, so it would do so
      // on every run.
      const pinnedLow = vertical ? band.left <= host.left + 1 : band.top <= host.top + 1;
      const pinnedHigh = vertical ? band.right >= host.right - 1 : band.bottom >= host.bottom - 1;
      if (first > 0 && !pinnedLow) {
        headSides += 1;
        worstHead = Math.max(
          worstHead,
          lines[first]!.start - low - Math.max(0, lines[first]!.start - lines[first - 1]!.end),
        );
      }
      if (last < lines.length - 1 && !pinnedHigh) {
        tailSides += 1;
        worstTail = Math.max(
          worstTail,
          high - lines[last]!.end - Math.max(0, lines[last + 1]!.start - lines[last]!.end),
        );
      }
    }
    expect(headSides, `${label}：没有一屏的上缘旁边有行，扫不到上缘`).toBeGreaterThan(2);
    expect(tailSides, `${label}：没有一屏的下缘旁边有行，扫不到下缘`).toBeGreaterThan(2);
    console.log(
      `${label}: head ${headSides}x worst=${worstHead.toFixed(1)}; ` +
        `tail ${tailSides}x worst=${worstTail.toFixed(1)}`,
    );
    return { worstHead, worstTail };
  };

  // A hair of slack for the arithmetic: the band's edges land on fractional
  // coordinates and the line boxes are measured to a tenth, so a band that is
  // exactly as padded as the air allows can read a hundredth over. The overrun
  // being caught is 5–6px on this book, so nothing here hides it.
  const SLACK = 0.5;
  await typography("跟随书籍");
  const follow = await overreach("跟随书籍");
  expect(follow.worstHead, "跟随书籍：带子上缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);
  expect(follow.worstTail, "跟随书籍：带子下缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);

  // And the roomier page, where the design's three tenths has real air to sit in:
  // the same rule holds, and the band is still padded rather than welded on.
  await typography("自定义");
  const custom = await overreach("自定义");
  expect(custom.worstHead, "自定义：带子上缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);
  expect(custom.worstTail, "自定义：带子下缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);
});

test("the band still hugs the text when the sidebar leaves the pane", async ({ page }) => {
  // Collapsing, hiding and showing the sidebar (and going fullscreen) each resize
  // the reading pane, and the pane's own resize is only half the story: the page
  // is pinned through the spring and laid out *again* once the pin lets go, at a
  // moment no element resizes.
  //
  // So the band has to follow the words to the *second* layout, and the trap is
  // that the second layout arrives inside a reading area of the size it already
  // has. A placement keyed on the area alone therefore decides, on the pinned
  // layout, that the band is already where this pane wants it — and the words
  // then re-wrap under a band that kept the measure of the page it was drawn on.
  // Measured here: 117px out on a 1208px pane, on the one state whose width is
  // set in two steps (hiding the sidebar swaps the rail for a caret that mounts
  // afterwards). The key carries the measure the words were set in, so the
  // re-wrap is a different page as far as the band is concerned.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  for (const label of ["折叠侧边栏", "隐藏侧边栏", "全屏阅读"]) {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    // Wait for the band to come to rest, *then* read the page: the pane re-wraps
    // and the band re-derives a frame or two after the transition starts, and a
    // line list read in between belongs to a layout neither number came from.
    await page.waitForTimeout(1600);
    const drawn = await rulerDrawn(page);
    await page.waitForTimeout(200);
    const lines = (await page.evaluate(LINES)) as Interval[];
    expect(lines.length, `${label}：一个字的行盒都没量到`).toBeGreaterThan(3);
    // On whole lines, and as wide as the ones it is on.
    const covered = coveredLines(drawn, lines, `${label}：`);
    hugsText(drawn, covered.covered, `${label}：`);
  }
});

test("the page next door does not widen the band, in either page layout", async ({ page }) => {
  // A paginated section is one long strip of pages inside a single iframe, and
  // the page on screen is a *window* onto it: the strip is a chapter wide, the
  // paginator clips it to a page box narrower than the reading pane, and the
  // pages either side are simply not painted.
  //
  // The pane's own coordinates cannot tell that from text. The page next door
  // starts *inside* the pane's outer margin, so its first line — a short one, a
  // heading or a paragraph's first line — is a fragment a couple of hundred
  // pixels long sitting well inside the pane, and it clears every "is it in the
  // reading area" test there is. The band's width is the union of the lines it
  // washes, so that one phantom line dragged the band's edge out to the pane's
  // own edge and the reader saw a band running a third of a page past the words.
  //
  // It is the *painted page* that has to decide, and only the renderer knows
  // where that is. Measured on a real book, 折叠侧边栏: the band 929px wide on
  // 672px of words, the phantom a `P` 162px wide starting 79px past the page box.
  //
  // Both page layouts are walked, because the two differ in exactly the way that
  // matters — a single page puts the next page one column away, a spread puts a
  // whole second column of the *same* page on the other side of the gutter, and
  // a band that is only too wide on one of them is a band that is only too wide
  // when the reader happens to be reading there.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  // Puts a line where the page next door would put one: inside the reading
  // pane, outside the page the paginator paints, at the height the band is on.
  // It is a real box with real text and every platform reports it visible —
  // nothing about the fragment can refuse it, only the page box can.
  const phantom = (on: boolean) =>
    page.evaluate((show: boolean) => {
      const frame = document
        .querySelector("foliate-view")
        ?.shadowRoot?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelector("iframe");
      const doc = frame?.contentDocument;
      if (!frame || !doc?.body) return false;
      const existing = doc.querySelector("[data-phantom]");
      if (!show) {
        existing?.remove();
        return true;
      }
      if (existing) return true;
      const frameBox = frame.getBoundingClientRect();
      // The page box: the first ancestor of the frame narrower than the strip.
      let painted = null;
      for (let el = frame.parentElement; el; el = el.parentElement) {
        const box = el.getBoundingClientRect();
        if (box.width > 0 && box.width < frameBox.width) {
          painted = box;
          break;
        }
      }
      if (!painted) return false;
      const band = document.querySelector("[data-ruler-band]")?.getBoundingClientRect();
      if (!band) return false;
      const line = doc.createElement("p");
      line.setAttribute("data-phantom", "");
      line.textContent = "下一页的第一行，在页面之外，谁也看不见。".repeat(4);
      // Positioned in the *frame's* coordinates, past the page's right edge and
      // level with the band: inside the reading pane, outside the painted page.
      line.style.cssText = [
        "position:absolute",
        "margin:0",
        "white-space:nowrap",
        `left:${painted.right - frameBox.left + 40}px`,
        `top:${band.top - frameBox.top + 4}px`,
      ].join(";");
      doc.body.append(line);
      return true;
    }, on);

  // Both states are exercised from a fresh sidebar each time: collapsing it is
  // what puts the phantom inside the pane's margin in the first place, and the
  // toggles are only on screen while the sidebar is showing.
  for (const [mode, collapse] of [
    ["单页", "折叠侧边栏"],
    ["双页", "隐藏侧边栏"],
  ] as const) {
    await choose(page, mode);
    await page.getByRole("button", { name: collapse, exact: true }).first().click();
    await page.waitForTimeout(2000);

    expect(await phantom(false), "没有找到 section 的文档，注入没做").toBe(true);
    const before = await rulerDrawn(page);
    expect(await phantom(true), "没有找到 section 的文档，注入没做").toBe(true);
    // The pane's own resize is the ruler's re-measure, and it is the one thing
    // here that is not the subject under test: the same width, the same page,
    // the same lines, measured again with and without the phantom in it.
    await page.setViewportSize({ width: 1282, height: 820 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForTimeout(1200);
    const withPhantom = await rulerDrawn(page);
    expect(await phantom(false), "没有找到 section 的文档，注入没做").toBe(true);
    await page.waitForTimeout(1200);
    const after = await rulerDrawn(page);

    const area = before.host.right - before.host.left;
    // Same width, same page, same lines: the only difference is a fragment on a
    // page the reader cannot see, so neither edge of the band may have moved.
    expect(
      Math.abs(withPhantom.band.left - before.band.left),
      `${mode}：看不见的下一页把带的左缘拖走了`,
    ).toBeLessThan(1.5);
    expect(
      Math.abs(withPhantom.band.right - before.band.right),
      `${mode}：看不见的下一页把带的右缘拖走了`,
    ).toBeLessThan(1.5);
    // …and nowhere near the pane's own edge, which is the shape of the report:
    // the phantom reaches into the pane's margin, so a band that counted it
    // runs to within a hair of the edge.
    expect(
      withPhantom.band.right - before.host.left,
      `${mode}：带子顶到了阅读区的右缘（它量到了看不见的下一页）`,
    ).toBeLessThan(area - 40);
    // …and taking it away puts the band back, which is what says the two
    // readings above are of the same page.
    expect(
      Math.abs(after.band.right - before.band.right),
      `${mode}：带子没有回到原位`,
    ).toBeLessThan(1.5);
    // Back to a showing sidebar for the next layout. Both toggles live in
    // different places — the collapsed rail's own chevron and the docked caret
    // the hidden state leaves behind — so whichever is on screen answers.
    const restore = page.getByRole("button", { name: /展开侧边栏|显示侧边栏/ }).first();
    await restore.click();
    await page.waitForTimeout(1800);
  }
});

test("text nobody can see does not move the band's edges", async ({ page }) => {
  // A book that carries text the reader never sees — a print-only running head, a
  // clipped helper, a line with no font but a leading — has a *box* for it all
  // the same, and a box is all a ruler can read. Measured on a real book, one of
  // those was the widest thing in the section: the band came out 13–29% of the
  // window wider than the words, in every state that re-lays the pane out (the
  // sidebar collapsing, hiding or coming back; fullscreen).
  //
  // Nothing can filter that fragment out by looking at it: it is inside the
  // reading area, inside the page, and the platform reports it visible. The band
  // is a window on the block it is drawn on, so the width comes from those lines
  // and this box is simply not one of them.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  /** Puts a line into the section that the reader cannot see, over the part of
   *  the page the column's own text stops at — the only place a fragment like
   *  this can hide from a filter. `null` takes it away again. */
  const ghost = (on: boolean) =>
    page.evaluate((show: boolean) => {
      const frame = document
        .querySelector("foliate-view")
        ?.shadowRoot?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelector("iframe");
      const doc = frame?.contentDocument;
      if (!doc?.body) return false;
      const existing = doc.querySelector("[data-ghost]");
      if (!show) {
        existing?.remove();
        return true;
      }
      if (existing) return true;
      // A real box — real height, real width, the full content width of the
      // page — that simply paints nothing: `color: transparent` is how a book
      // carries a print-only running head or a helper line, and every platform
      // reports it visible, because it is. Nothing that looks at the fragment
      // can refuse it; only the band's own width, taken from the lines it is
      // drawn on, can.
      const line = doc.createElement("p");
      line.setAttribute("data-ghost", "");
      line.textContent = "没有人看得见的一行字，但它照样有一个盒子。".repeat(8);
      // Wider than the column on purpose, and out to the right of where the
      // column's own text stops — the shape the report had: a box as wide as the
      // page's content where the words are a narrower measure inside it. The demo
      // prose fills its column, so a ghost the same width as the text would prove
      // nothing.
      line.style.cssText = "color:transparent;margin:0;width:180%;white-space:nowrap";
      doc.body.append(line);
      return true;
    }, on);

  // The pane's own resize is the ruler's re-measure, and it is the one thing here
  // that is not the subject under test: the same width, the same page, the same
  // lines, measured again with and without the ghost in it. (Out and back, so the
  // two readings are of the same layout and not of two widths.)
  const remeasure = async (width: number) => {
    await page.setViewportSize({ width: width + 2, height: 820 });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(900);
    return rulerDrawn(page);
  };
  const width = 1264;

  expect(await ghost(false), "没有找到 section 的文档，注入没做").toBe(true);
  const without = await remeasure(width);
  expect(await ghost(true), "没有找到 section 的文档，注入没做").toBe(true);
  const withGhost = await remeasure(width);
  expect(await ghost(false), "没有找到 section 的文档，注入没做").toBe(true);
  const back = await remeasure(width);

  // Same width, same page, same lines: the only difference is a fragment the
  // reader cannot see, so neither edge of the band may have moved. (A pixel of
  // slack for the engine rounding a column width at the width under test.)
  expect(
    Math.abs(withGhost.band.left - without.band.left),
    "看不见的文字把带的左缘拖走了",
  ).toBeLessThan(1.5);
  expect(
    Math.abs(withGhost.band.right - without.band.right),
    "看不见的文字把带的右缘拖走了",
  ).toBeLessThan(1.5);
  // …and nowhere near the pane's own edge, which is what a fragment this wide
  // does to it — the shape of the report, in one number.
  const area = without.host.right - without.host.left;
  expect(withGhost.band.right - without.host.left, "带子顶到了阅读区的右缘").toBeLessThan(
    area - 40,
  );
  // …and taking it away puts the band back where it was, which is what says the
  // two readings above are of the same page.
  expect(Math.abs(back.band.right - without.band.right), "带子没有回到原位").toBeLessThan(1.5);
});

test("the band lands on whole lines, on a real EPUB, and again after a page turn", async ({
  page,
}) => {
  // The foliate path is the one with a question to answer: its lines are in a
  // section iframe, so a ruler that measured its own document would fall back to
  // arithmetic and no test of the prose path would ever notice.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  const onWholeLines = async (label: string) => {
    const drawn = await rulerDrawn(page);
    const lines = (await page.evaluate(LINES)) as Interval[];
    expect(lines.length, `${label}：一个字的行盒都没量到`).toBeGreaterThan(3);
    return coveredLines(drawn, lines, `${label}：`);
  };

  const before = await onWholeLines("翻页前");
  // `PageDown`, not an arrow: the ruler owns the arrows while it is on — that is
  // what reading with it means — and these are the page-turner's own keys.
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(1400);
  const after = await onWholeLines("翻页后");

  // The page moved under the band and the band was re-derived from the page it is
  // now over: it still covers whole lines of the page in front of the reader.
  expect(after.count, "翻页之后带覆盖的行数变了").toBe(before.count);
  // A turn is a page the reader *arrives on*, so the band meets it at its start
  // — the first block of the new page, not wherever the band was when the old
  // page left (that is the bottom of it, after a page read with the ruler).
  const lines = (await page.evaluate(LINES)) as Interval[];
  const firstIndex = lines.findIndex((line) => line.start === after.first);
  expect(firstIndex, "翻页之后带没有回到下一页的顶部").toBeGreaterThanOrEqual(0);
  expect(firstIndex, "翻页之后带没有回到下一页的顶部").toBeLessThanOrEqual(3);
});

test("dragging the band moves it, follows the hand, and the place is remembered", async ({
  page,
}) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await enableRuler(page);

  const before = await rulerDrawn(page);
  const box = (await page.locator('[data-ruler-edge="leading"]').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 120, { steps: 12 });

  // While it is still held: the band is where the hand is, and it stays there.
  // The old one re-snapped onto the nearest line on every frame, which is what
  // made it look like it was fighting the pointer.
  const holding = (await page.evaluate(DRAWN)) as Drawn | null;
  expect(holding, "阅读标尺没有画出来").not.toBeNull();
  expect(holding!.band.top, "拖动中带没有跟住指针").toBeGreaterThan(before.band.top + 80);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const dragged = await rulerDrawn(page);
  expect(dragged.band.top, "松开之后带没有停在拖动到的位置").toBeGreaterThan(before.band.top + 80);
  expect(spanAlong(dragged), "拖动之后带与上下遮罩不再铺满阅读区").toBeCloseTo(
    spanAlong(before),
    0,
  );

  // Remembered: a fresh visit reopens on the place it was left, not on the parked
  // fraction it started at.
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  const remembered = await rulerDrawn(page);
  const lead = advanceOf((await page.evaluate(LINES)) as Interval[]);
  expect(remembered.band.top, "重新打开之后带回到了默认位置").toBeGreaterThan(before.band.top + 80);
  expect(
    Math.abs(remembered.band.top - dragged.band.top),
    "重新打开之后带没有停在拖动到的位置",
  ).toBeLessThan(lead * 2);
});

test("the colour reaches the band: 仅描边 draws hairlines, 黄色 fills it", async ({ page }) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await enableRuler(page);

  const clear = await rulerDrawn(page);
  expect(clear.fill, "仅描边是默认，不该给带填色").toBe("rgba(0, 0, 0, 0)");
  expect(
    clear.borders.filter((width) => Number.parseFloat(width) > 0),
    "仅描边应当给带的四条边各画一条：只有两条长边的话，带的两端读起来是断开的",
  ).toHaveLength(4);

  await choose(page, "黄色");
  const yellow = await rulerDrawn(page);
  expect(yellow.fill, "选了黄色，带却没有填色").not.toBe("rgba(0, 0, 0, 0)");
  expect(yellow.fill).not.toBe(clear.fill);
});

test("vertical type turns the band into a column, washed on either side", async ({ page }) => {
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);
  await choose(page, "竖排");

  const drawn = await rulerDrawn(page);
  const height = drawn.host.bottom - drawn.host.top;
  const width = drawn.host.right - drawn.host.left;
  // A line is a column now, so the band stands up and the washes sit to its left
  // and right — along the page, because that is the axis the type now reads on.
  expect(drawn.vertical, "竖排下标尺应当变成竖条").toBe(true);
  expect(across(drawn.band, drawn.vertical), "竖排下标尺应当贯穿阅读区的高度").toBeCloseTo(
    height,
    -2,
  );
  expect(spanAlong(drawn), "竖排下带与左右遮罩加不满阅读区").toBeCloseTo(width, 0);
});

test("on a spread the band covers one column, and the other one is washed", async ({ page }) => {
  // A spread is two independent flows side by side, and their line grids do not
  // agree — one column's paragraph may break where the other's does not. A band
  // spanning both would cut lines in one of them whichever column it snapped to,
  // so it covers the column being read and the other one goes with the rest of
  // the washed page.
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await choose(page, "双页");
  await enableRuler(page);

  const drawn = await rulerDrawn(page);
  const width = drawn.host.right - drawn.host.left;
  const middle = (drawn.host.left + drawn.host.right) / 2;

  expect(across(drawn.band, false), "双页下标尺横跨了整页").toBeLessThan(width * 0.6);
  expect(
    drawn.band.right <= middle || drawn.band.left >= middle,
    "双页下标尺横跨了中缝：它应当只盖住正在读的那一栏",
  ).toBe(true);
  // The other column is part of the wash, and the window still tiles the page.
  expect(spanAcross(drawn), "双页下带与两侧遮罩加不满阅读区").toBeCloseTo(width, 0);
  expect(
    Math.max(across(drawn.leading.box, false), across(drawn.trailing.box, false)),
    "双页下另一栏没有被洗淡",
  ).toBeGreaterThan(width * 0.2);

  // And it is still on whole lines — of its own column, which is the column the
  // band is on and only that one — and as wide as that column's own text, not a
  // strip that runs past it into the margin or the gutter.
  const side: -1 | 1 = drawn.band.right <= middle ? -1 : 1;
  const inColumn = await columnLines(page, side);
  expect(inColumn.length, "双页下带所在的一栏一行都没量到").toBeGreaterThan(3);
  const covered = coveredLines(drawn, inColumn);
  expect(covered.count, "双页下带没有盖住整行").toBe(2);
  hugsText(drawn, covered.covered);
});

test("an arrow steps the band a whole block at a time, and the step is a move", async ({
  page,
}) => {
  // 单页, because that is where the arrows are the ruler's: in the scroll layout
  // they are the reader's own scrolling, and the band stays where it is while the
  // text moves under it.
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await choose(page, "单页");
  await enableRuler(page);

  // A step declares a transition on the band; a jump declares none. Counting the
  // events the band itself reports keeps this a fact about the band rather than a
  // race against the frame it happens to be drawn on.
  const installed = await page.evaluate(`(() => {
    const band = document.querySelector("[data-ruler-band]");
    if (!band) return false;
    window.__rulerRuns = 0;
    band.addEventListener("transitionrun", () => { window.__rulerRuns += 1; });
    return true;
  })()`);
  expect(installed, "标尺没有画出来").toBe(true);

  const start = await rulerDrawn(page);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(800);
  const stepped = await rulerDrawn(page);

  const lines = (await page.evaluate(LINES)) as Interval[];
  const lead = advanceOf(lines);
  const moved = stepped.band.top - start.band.top;
  // One block down: two lines of the reader's setting, and no further.
  expect(moved, "按方向键之后带没有前进").toBeGreaterThan(lead * 1.4);
  expect(moved, "按方向键之后带走过了不止一个块").toBeLessThan(lead * 3.2);
  expect(coveredLines(stepped, lines).count, "步进之后带没有盖住整行").toBe(2);
  expect(
    (await page.evaluate("window.__rulerRuns")) as number,
    "步进没有动画，带是直接跳过去的",
  ).toBeGreaterThan(0);

  // Walk to the foot of the page. The band refuses at the last block, and what
  // the key does then is what a page turn is: the page moves on.
  const wasAt = await progress(page);
  for (let i = 0; i < 26; i += 1) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1600);

  const end = await rulerDrawn(page);
  const endLead = advanceOf((await page.evaluate(LINES)) as Interval[]);
  const thickness = end.band.bottom - end.band.top;
  expect(thickness, "走到底之后带变薄了").toBeGreaterThan(endLead * 1.4);
  expect(thickness, "走到底之后带变厚了").toBeLessThan(endLead * 4);
  expect(end.band.top, "走到底之后带跑出了阅读区的上边").toBeGreaterThanOrEqual(end.host.top - 1);
  expect(end.band.bottom, "走到底之后带跑出了阅读区的下边").toBeLessThanOrEqual(
    end.host.bottom + 1,
  );
  // …and it is still *on the page*: a ruler that lives inside the scrolling
  // content is carried off with the page that just left, and only its geometry
  // says so.
  expect(end.band.left, "翻页之后带被带出了阅读区的左边").toBeGreaterThanOrEqual(end.host.left - 1);
  expect(end.band.right, "翻页之后带被带出了阅读区的右边").toBeLessThanOrEqual(end.host.right + 1);
  expect(await progress(page), "带走到页面末尾之后，方向键没有翻页").toBeGreaterThan(wasAt);
});
