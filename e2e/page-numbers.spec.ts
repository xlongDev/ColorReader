import { expect, test, type Page } from "@playwright/test";

/**
 * The page indicator's whole-book mode.
 *
 * Two paths produce that number and they are built differently on purpose:
 *
 * - a foliate book (EPUB / Kindle) is numbered by foliate itself — the reader's
 *   position in the book's own byte domain — so the total is a property of the
 *   book and the position only ever rises;
 * - the prose pager has no such scale, so what it counts is the chapters the
 *   layout has measured plus the rest of the book weighed at that density
 *   (`bookPagesOf`), which is why only that one is labelled an estimate.
 *
 * Both are probed by reading, not by rendering, because the defect they replace
 * looked entirely plausible on screen: the same EPUB printed 493, 977, 805,
 * 2202 and 939 pages to one reader as it was read, and a page turn inside a
 * chapter left the number standing still. What no unit test can see is whether
 * the right *input* reached the arithmetic, so each test walks the book page by
 * page and reads the indicator every time:
 *
 * 1. the total never changes — a book does not grow or shrink while it is read;
 * 2. the position rises as the reader moves, and reaches the total at the end;
 * 3. only the estimate says 约;
 * 4. a turn in a spread moves the counter by the two pages that turned.
 *
 * The shelf is deliberately not uniform: `demo-1`'s fourth chapter is a single
 * short paragraph against three long ones, and the EPUB fixture's chapters are
 * 40 / 40 / 20 / 1 paragraphs. A book whose chapters are all one length makes
 * every estimator look right — including the one that extrapolated the book
 * from whichever chapter happened to be on screen, which is how the 493/2202
 * numbers came out.
 *
 * Assertions are relational rather than absolute on purpose: WebKit lays the
 * same text out wider than Chromium and paginates it differently, so any pinned
 * page count would only be pinning the engine. `?demo=1` supplies the sample
 * shelf; `&epub=1` adds the fixture EPUB on top of it.
 */

/** The indicator's numbers, or null when it is not on screen at all. */
async function indicator(
  page: Page,
): Promise<{ page: number; total: number; est: boolean } | null> {
  const el = page.locator("[data-page-indicator]");
  if ((await el.count()) === 0) return null;
  const text = (await el.innerText()).trim();
  const match = /^(约\s*)?(\d+)\s*\/\s*(\d+)\s*页$/.exec(text);
  if (!match) throw new Error(`页码读不出来：${JSON.stringify(text)}`);
  return { est: match[1] !== undefined, page: Number(match[2]), total: Number(match[3]) };
}

async function readIndicator(page: Page) {
  const value = await indicator(page);
  expect(value, "页码指示器没有出现").not.toBeNull();
  return value!;
}

/** Opens a sample book and settles on the reader's first page. */
async function openReader(
  page: Page,
  { query = "/?demo=1", title = /我们为什么会生病/ }: { query?: string; title?: RegExp } = {},
) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(query);
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(800);
}

/** Sets one chip in the settings drawer, then closes it. */
async function choose(page: Page, group: string, label: string) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  // Scoped to the group: 单页 and 双页 are layout chips, and 隐藏 / 当前章 /
  // 全书 are the page-number ones, but a bare label match would also find the
  // 排版模式 group's own rows.
  const row = page
    .locator("aside div")
    .filter({ has: page.getByText(group, { exact: true }) })
    .last();
  await row.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
}

/** The reading page, so a flip has settled before the indicator is read. */
async function flip(page: Page, times: number) {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(400);
}

/**
 * Turns pages to the end of the book, reading the indicator on every page.
 *
 * A chapter's last page and its successor's first can report the same number —
 * the boundary rounds to the same page — so "the reading stopped changing"
 * takes three turns in a row, not one. Bounded, because an unbounded loop would
 * hang the suite rather than fail it.
 */
async function walkToTheEnd(page: Page) {
  const readings = [await readIndicator(page)];
  let still = 0;
  for (let i = 0; i < 60 && still < 3; i += 1) {
    await flip(page, 1);
    const next = await readIndicator(page);
    const last = readings[readings.length - 1]!;
    still = next.page === last.page && next.total === last.total ? still + 1 : 0;
    readings.push(next);
  }
  return readings;
}

/** The invariants both paths share, checked against a whole walk. */
function expectSteady(
  readings: { page: number; total: number }[],
  label: string,
): { page: number; total: number } {
  const totals = [...new Set(readings.map((reading) => reading.total))];
  expect(
    totals,
    `${label}的全书页数在阅读中变了：${readings.map((r) => r.total).join(" → ")}`,
  ).toHaveLength(1);

  const first = readings[0]!;
  const last = readings[readings.length - 1]!;
  for (const [index, reading] of readings.entries()) {
    if (index === 0) continue;
    expect(
      reading.page,
      `${label}的页码会倒退：${readings.map((r) => r.page).join(" → ")}`,
    ).toBeGreaterThanOrEqual(readings[index - 1]!.page);
  }
  expect(last.page, "读完一本后页码应当停在总页数上").toBe(last.total);
  expect(first.page, "翻过一整本书之后页码应当动过").toBeLessThan(last.page);
  return last;
}

test("a foliate book's whole-book count is the book's own, and never moves", async ({ page }) => {
  // The reported defect: an EPUB's whole-book number swung by hundreds of pages
  // as it was read, stood still across a page turn, and printed the section's
  // own "1 / 1" wherever the estimate had nothing to work with.
  await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "全书");

  const first = await readIndicator(page);
  // foliate numbers the book's own bytes, which is measured, not estimated:
  // there is nothing to warn about with 约.
  expect(first.est, "foliate 的书内页码不是估算，不该带「约」").toBe(false);
  expect(first.page).toBeLessThanOrEqual(first.total);

  const last = expectSteady(await walkToTheEnd(page), "EPUB");
  expect(last.total, "一本 12 页的样书不该报成几十页").toBeLessThan(100);
});

test("the prose pager's whole-book count does not move as the book is read", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "全书");

  const first = await readIndicator(page);
  expect(first.est, "全书页码必须标出它是估算").toBe(true);
  expect(first.page).toBeLessThanOrEqual(first.total);

  expectSteady(await walkToTheEnd(page), "纯文本样书");
});

test("the chapter scope is not an estimate and the indicator says so", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "当前章");

  const chapter = await readIndicator(page);
  expect(chapter.est, "当前章页码是实测的，不该带「约」").toBe(false);

  // Same position, whole-book scope: an estimate, and a longer book than one
  // chapter of it.
  await choose(page, "页码", "全书");
  const book = await readIndicator(page);
  expect(book.est).toBe(true);
  expect(book.total).toBeGreaterThan(chapter.total);
});

test("hiding the indicator takes it off the page", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "全书");
  expect(await indicator(page)).not.toBeNull();

  await choose(page, "页码", "隐藏");
  expect(await indicator(page), "隐藏之后不该还有页码").toBeNull();
});

/**
 * A spread turns two pages, so the counter has to move two.
 *
 * The number is what a reader checks a turn against: if the page visibly moves
 * on by two and "N / M 页" moves on by one, the count and the page disagree, and
 * a reader who counts pages (or quotes one) is off by one from wherever they
 * actually are. Both paths are asserted, because both count pages of their own
 * unit — foliate columns per turn, the prose pager's column pitch — and only
 * one of them got it right before.
 */
test("one turn moves the chapter counter by the two pages a spread shows", async ({ page }) => {
  await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
  await choose(page, "排版模式", "双页");
  await choose(page, "页码", "当前章");

  const before = await readIndicator(page);
  await flip(page, 1);
  const after = await readIndicator(page);
  expect(after.page - before.page, "EPUB 双页排版一次翻页应当走过两页").toBe(2);
  expect(after.total, "翻页不该改动本章的页数").toBe(before.total);
  expect(after.page).toBeLessThanOrEqual(after.total);
});

test("the prose pager also counts a spread's two pages", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "双页");
  await choose(page, "页码", "当前章");

  const before = await readIndicator(page);
  await flip(page, 1);
  const after = await readIndicator(page);
  expect(after.page - before.page, "纯文本双页排版一次翻页应当走过两页").toBe(2);
  expect(after.total).toBe(before.total);
  expect(after.page).toBeLessThanOrEqual(after.total);
});
