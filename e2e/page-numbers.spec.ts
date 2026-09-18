import { expect, test, type Page } from "@playwright/test";

/**
 * The page indicator's whole-book mode.
 *
 * The estimator itself is unit-tested (`bookPageAt`), and that covers the
 * arithmetic. What no unit test can see is whether the estimator is handed the
 * right *share of the book* — a wrong span produces a number that looks
 * perfectly plausible on screen, which is exactly the kind of defect that
 * survives review. So this probes the arithmetic instead of the rendering:
 *
 * 1. the total does not depend on where the reader is — a book is the same
 *    length from its first chapter and from its last;
 * 2. the last page of the book reports the total, which is the one place the
 *    estimate can be checked against something the layout actually measured;
 * 3. the estimate is labelled as one, and the chapter scope is not.
 *
 * The sample book's four chapters carry identical text, so a span read off the
 * wrong chapter or left un-normalised would break (1) immediately.
 *
 * Assertions are relational rather than absolute on purpose: WebKit lays the
 * same text out wider than Chromium and paginates it differently, so any pinned
 * page count would only be pinning the engine.
 *
 * `?demo=1` supplies the sample shelf; without it the web build has no book to
 * open.
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

/** Opens the sample book and settles on the reader's first page. */
async function openReader(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: /我们为什么会生病/ })
    .first()
    .click();
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

test("the whole-book page number is the same length from either end", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "全书");

  const first = await readIndicator(page);
  expect(first.est, "全书页码必须标出它是估算").toBe(true);
  expect(first.total).toBeGreaterThan(1);
  expect(first.page).toBeLessThanOrEqual(first.total);

  // Jump to the last chapter through the TOC: the book's length must not
  // depend on which chapter is on screen.
  await page.getByRole("button", { name: "目录与书签" }).first().click();
  await page.waitForTimeout(700);
  await page
    .getByRole("button", { name: /第四章/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);

  const last = await readIndicator(page);
  expect(last.total, "同一本书在两章里报出两个长度").toBe(first.total);
  expect(last.page, "最后一章不可能比第一章还靠前").toBeGreaterThan(first.page);

  // Now walk to the end of the book. Bounded: a chapter of this fixture is a
  // handful of pages, and an unbounded loop would hang the suite rather than
  // fail it.
  let settled = last;
  for (let i = 0; i < 40; i += 1) {
    await flip(page, 1);
    const next = await readIndicator(page);
    if (next.page === settled.page) break;
    settled = next;
  }
  expect(settled.page, "翻到全书最后一页时，页码应当等于总页数").toBe(settled.total);
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
