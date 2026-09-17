import { expect, test, type Page } from "@playwright/test";

/**
 * Switching between the sidebar's pages.
 *
 * Two contracts, neither of which the unit suite can see — both only exist for
 * the third of a second a route change takes.
 *
 * 1. The four shelf views (书库 / 最近 / 收藏 / 标签) are one page with four
 *    filters, so a swap between them must not mount the shelf twice. A remount
 *    put two of them on screen for the length of every swap — 168 covers for an
 *    84-book library, on the switches a reader makes most.
 * 2. A swap between pages travels the way the reader moved down the sidebar:
 *    the page they left carries on, the one they asked for comes in from the
 *    other side. Read off the wrapper's own offset, which is why the shell
 *    tags it (`data-page-swap`).
 *
 * `?demo=1&books=84` sizes the sample shelf like a real one. With the fixture's
 * default three books neither contract could fail.
 */
const SHELF = "/?demo=1&books=84";

/** Peaks of everything that must not double up while pages are swapped. */
async function watchPeaks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { peak?: { shelves: number; covers: number } };
    w.peak = { shelves: 0, covers: 0 };
    const sample = () => {
      w.peak!.shelves = Math.max(
        w.peak!.shelves,
        document.querySelectorAll("[data-shelf-scroller]").length,
      );
      w.peak!.covers = Math.max(
        w.peak!.covers,
        document.querySelectorAll("[data-book-cover]").length,
      );
    };
    sample();
    window.setInterval(sample, 16);
  });
}

test("the four shelf views never mount two shelves", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SHELF);
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await watchPeaks(page);

  for (const label of ["最近", "收藏", "标签", "书库"]) {
    await page.getByRole("link", { name: label }).first().click();
    await page.waitForTimeout(450);
  }

  const peak = await page.evaluate(
    () => (window as unknown as { peak: { shelves: number; covers: number } }).peak,
  );
  expect(peak.shelves, "one shelf at a time").toBe(1);
  expect(peak.covers, "84 books, 84 covers — never 168").toBe(84);
});

/**
 * The largest offset each wrapper took while the swap ran: for the arriving
 * page that is where it came in from, for the leaving one how far it went.
 */
async function swapOffsets(page: Page, click: string) {
  await page.evaluate(() => {
    const w = window as unknown as { seen?: Record<string, number>; stop?: boolean };
    w.seen = {};
    w.stop = false;
    const tick = () => {
      if (w.stop) return;
      for (const el of document.querySelectorAll("[data-page-swap]")) {
        const path = el.getAttribute("data-page-swap") ?? "?";
        const y = Math.round(new DOMMatrix(getComputedStyle(el).transform).m42);
        if (Math.abs(y) > Math.abs(w.seen![path] ?? 0)) w.seen![path] = y;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.getByRole("link", { name: click }).first().click();
  await page.waitForTimeout(420);
  return page.evaluate(() => {
    const w = window as unknown as { seen: Record<string, number>; stop: boolean };
    w.stop = true;
    return w.seen;
  });
}

test("a swap travels the way the reader moved down the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SHELF);
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  // Warm the stats chunk: a cold fetch would land inside the measurement.
  await page.getByRole("link", { name: "统计" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("link", { name: "书库" }).first().click();
  await page.waitForTimeout(700);

  // Down the list: the arriving page comes from below, the leaving one goes up.
  const down = await swapOffsets(page, "统计");
  expect(down["/stats"], "统计 arrives from below").toBeGreaterThan(20);
  expect(down["/"], "书库 leaves upward").toBeLessThan(-20);
  await page.waitForTimeout(300);

  // Up the list: mirrored, or the two pages would read as moving together.
  const up = await swapOffsets(page, "书库");
  expect(up["/"], "书库 arrives from above").toBeLessThan(-20);
  expect(up["/stats"], "统计 leaves downward").toBeGreaterThan(20);
});
