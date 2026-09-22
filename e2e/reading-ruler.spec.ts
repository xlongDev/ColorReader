import { expect, test, type Page } from "@playwright/test";

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
        // Off the reading area on either axis, and by more than a hair: the page
        // next door in a paged book sits flush against the window, a fraction of
        // a pixel inside it, at heights and widths no line of this page has.
        if (
          right - hostBox.left <= 1 ||
          hostBox.right - left <= 1 ||
          bottom - hostBox.top <= 1 ||
          hostBox.bottom - top <= 1
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
 * arithmetic has edges at arbitrary offsets instead — which is what the two
 * offsets being equal is here to catch, since an arithmetic band has no reason
 * for them to agree.
 *
 * Only for a band that is not against the page's own edge: the band is clamped
 * inside the reading area, and a clamped band is legitimately off centre on its
 * block.
 */
function coveredLines(drawn: Drawn, lines: readonly Span[], label = "") {
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
  expect(Math.abs(head - tail), `${label}带没有居中在它盖住的行上`).toBeLessThan(3);

  return { count: covered.length, first: covered[0]!.start };
}

/**
 * The band hugs the text it covers, across the page.
 *
 * The extent the ruler draws to is the text's own outermost edges, a pad outside
 * them; what it must never be is a strip across the whole window, nor one that
 * stops short of the lines it covers — the first reads as a band fading out into
 * the margin, the second as a wash cutting into the text.
 */
function hugsText(drawn: Drawn, lines: readonly Interval[], label = "") {
  const vertical = drawn.vertical;
  // `left`/`right` are the line's cross-axis extent in window coords in both
  // writing modes; `start`/`end` are the *reading* axis, which for vertical type
  // runs leftward and would compare apples to oranges here. The band's cross
  // extent runs the other way round: across the page for horizontal type, up and
  // down for vertical.
  const low = Math.min(...lines.map((line) => line.left));
  const high = Math.max(...lines.map((line) => line.right));
  const bandLow = vertical ? drawn.band.top : drawn.band.left;
  const bandHigh = vertical ? drawn.band.bottom : drawn.band.right;
  // The pad outside the text is three tenths of the reader's leading, which the
  // page's own advance approximates.
  const pad = advanceOf(lines) * 0.3 + 2;
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
  hugsText(drawn, lines);
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
  expect(coveredLines(drawn, inColumn).count, "双页下带没有盖住整行").toBe(2);
  hugsText(drawn, inColumn);
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
