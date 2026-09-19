import { expect, test, type Page } from "@playwright/test";

/**
 * The reader's position engine: the one part of the app no unit test can see.
 *
 * `paging.ts` covers the column arithmetic and `progress.ts` covers the
 * estimator, but both are handed values by a component that owns them — and
 * the defects that hurt are in the handing, not in the maths: position
 * re-applied at the wrong moment (the page snapping back to the top), a
 * fraction that belongs to another chapter, a step that forgets to reset the
 * scroll. Every one of them renders a perfectly plausible page.
 *
 * So this suite drives the reader and reads the position back off the screen:
 *
 * - stepping a chapter moves the book forward, and the first chapter has
 *   nowhere back to go;
 * - jumping from the contents lands on that chapter, at its head;
 * - scrolling moves the progress readout, and scrolling back brings it home;
 * - in a paged layout, turning the page moves the column, not the chapter.
 *
 * `?demo=1` supplies the sample book — four chapters of the same prose, which
 * is what makes the progress assertions meaningful: a span read off the wrong
 * chapter would not be monotone.
 *
 * What this cannot cover, and why: the web preview has no Tauri backend, so
 * the sample book is plain text. foliate (epub / mobi / azw3), pdf.js and
 * search all need a real file or the backend to answer, and the persisted
 * position is a no-op outside the desktop runtime (`useSetProgress` short-
 * circuits). Those paths stay uncovered here — the reload round trip included.
 */

const BOOK = /我们为什么会生病/;
const SCROLLER = "[data-reading-content]";

async function openBook(page: Page) {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: BOOK }).first().click();
  await page.waitForSelector(`${SCROLLER} p`, { timeout: 15_000 });
  // The chapter body settles after the entrance; a measurement taken before
  // that reads the transform, not the layout.
  await page.waitForTimeout(900);
}

/**
 * The header's "第 N / M 章" readout, parsed.
 *
 * `textContent`, not `innerText`: WebKit blanks `innerText` on a node it is
 * not currently laying out, and the header is re-rendered while a drawer
 * animates in — so `innerText` reads "" exactly when the position is being
 * polled, on the one engine this app ships on.
 */
async function chapter(page: Page): Promise<{ index: number; total: number }> {
  const text = (await page.locator("header p").nth(1).textContent()) ?? "";
  const match = /第\s*(\d+)\s*\/\s*(\d+)\s*[章页]/.exec(text);
  if (!match) throw new Error(`章节读不出来：${JSON.stringify(text)}`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

/** `-1` while the header has not settled, so a poll can ride out a transition. */
async function chapterIndex(page: Page): Promise<number> {
  const text = (await page.locator("header p").nth(1).textContent()) ?? "";
  const match = /第\s*(\d+)\s*\/\s*(\d+)\s*[章页]/.exec(text);
  return match ? Number(match[1]) : -1;
}

/** Whole-book progress, as the footer prints it. */
async function progress(page: Page): Promise<number> {
  const text = await page.locator("[data-reader-progress]").first().innerText();
  return Number(text.replace("%", "").trim());
}

/** The reading area's own scroll offsets and overflow, measured in the page. */
function metrics() {
  const el = document.querySelector<HTMLElement>("[data-reading-content]");
  if (!el) return null;
  return {
    top: Math.round(el.scrollTop),
    left: Math.round(el.scrollLeft),
    scrollHeight: Math.round(el.scrollHeight),
    clientHeight: Math.round(el.clientHeight),
    scrollWidth: Math.round(el.scrollWidth),
    clientWidth: Math.round(el.clientWidth),
  };
}

async function read(page: Page) {
  const m = await page.evaluate(metrics);
  if (!m) throw new Error("阅读区不在页面上");
  return m;
}

/**
 * Grows the type until the chapter overflows its box, so a scroll assertion
 * has something to measure. Without this the sample chapter fits a tall
 * window whole, `scrollTop` is pinned at 0 and the test would pass without
 * testing anything.
 */
async function ensureScrollable(page: Page) {
  for (let i = 0; i < 10; i++) {
    const m = await read(page);
    if (m.scrollHeight > m.clientHeight + 40) return;
    await page.getByRole("button", { name: "放大字号" }).click();
    await page.waitForTimeout(150);
  }
  throw new Error("正文撑不出滚动：样本章节太短，放大字号也无效");
}

test("翻章推进进度，第一章没有上一章", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openBook(page);

  const first = await chapter(page);
  expect(first.index).toBe(1);
  expect(first.total).toBe(4);
  // The stepper promises a direction; at the head of the book there is only
  // one, and a button that looks available but does nothing is worse than a
  // disabled one.
  await expect(page.getByRole("button", { name: "上一章" })).toBeDisabled();

  const atFirst = await progress(page);
  await page.getByRole("button", { name: "下一章" }).click();
  await expect.poll(() => chapterIndex(page)).toBe(2);
  const atSecond = await progress(page);
  expect(atSecond, "翻到第二章后全书进度必须前进").toBeGreaterThan(atFirst);

  await page.getByRole("button", { name: "上一章" }).click();
  await expect.poll(() => chapterIndex(page)).toBe(1);
  expect(await progress(page), "回到第一章后进度必须回落").toBeLessThan(atSecond);
});

test("从目录跳转落在该章章首", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 460 });
  await openBook(page);
  await ensureScrollable(page);

  // Scroll away from the head first: the jump has to *move* the position, and
  // a reader already at the top could not tell a working jump from a no-op.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-reading-content]");
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
  expect((await read(page)).top, "正文必须先滚开，跳转才有可测的位移").toBeGreaterThan(40);

  await page.getByRole("button", { name: "目录与书签" }).click();
  await page.waitForTimeout(700);
  await page
    .getByRole("button", { name: /第三章/ })
    .first()
    .click();

  await expect.poll(() => chapterIndex(page)).toBe(3);
  // Landed at the chapter's head, not at whatever offset the previous chapter
  // was scrolled to — the pending fraction is applied after the body renders,
  // and the classic failure is applying it before, or not at all.
  await expect.poll(() => read(page).then((m) => m.top)).toBeLessThan(8);
});

test("滚动推进进度，回到顶部后回落", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 460 });
  await openBook(page);
  await ensureScrollable(page);

  const atTop = await progress(page);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-reading-content]");
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(500);
  const atBottom = await progress(page);
  expect(atBottom, "滚到章末后进度必须前进").toBeGreaterThan(atTop);

  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-reading-content]");
    if (el) el.scrollTop = 0;
  });
  await page.waitForTimeout(500);
  expect(await progress(page), "滚回章首后进度必须回落").toBeLessThan(atBottom);
});

test("分页模式下翻页推进列，而不是换章", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 520 });
  await openBook(page);

  // 单页 layout: one column per screenful, so a turn has somewhere to go.
  await page.getByRole("button", { name: "阅读设置" }).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "单页" }).click();
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);

  // A single-column chapter cannot be turned, and a turn that "works" on a
  // chapter that never overflowed proves nothing.
  for (let i = 0; i < 10; i++) {
    const m = await read(page);
    if (m.scrollWidth > m.clientWidth + 40) break;
    await page.getByRole("button", { name: "放大字号" }).click();
    await page.waitForTimeout(200);
  }
  const before = await read(page);
  expect(before.scrollWidth, "样本章节必须能排出多于一列").toBeGreaterThan(before.clientWidth);
  const chapterBefore = await chapterIndex(page);

  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(700);
  const after = await read(page);

  expect(after.left, "翻页必须把列推向前").toBeGreaterThan(before.left);
  expect(await chapterIndex(page), "一列未读完时不许换章").toBe(chapterBefore);
});
