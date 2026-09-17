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
 *
 * Read off the inline style motion writes each frame, rather than sampled on a
 * timer. A timer's samples are as sparse as the main thread is busy, and a route
 * change is the busiest moment this app has: on WebKit in CI every sample of a
 * swap fell outside the 150ms an exit lasts, so the outgoing page read 0 and the
 * test failed on a page that had visibly moved. A mutation callback runs in the
 * frame the value is written, so this sees every value the animation produced —
 * including the one the arriving page is born with.
 */
async function watchOffsets(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { seen?: Record<string, number> };
    w.seen = {};
    const read = (element: Element) => {
      const path = element.getAttribute("data-page-swap");
      if (path === null) return;
      const y = Math.round(new DOMMatrix(getComputedStyle(element).transform).m42);
      if (Math.abs(y) > Math.abs(w.seen![path] ?? 0)) w.seen![path] = y;
    };
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (target instanceof Element && target.hasAttribute("data-page-swap")) read(target);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["style"], subtree: true });
  });
}

async function swapOffsets(page: Page, click: string) {
  await watchOffsets(page);
  await page.getByRole("link", { name: click }).first().click();
  await page.waitForTimeout(420);
  return page.evaluate(() => (window as unknown as { seen: Record<string, number> }).seen);
}

/**
 * How far the arriving page must have come for this test to call it a step in
 * that direction — not the full `PAGE_SHIFT`. The offset it is born with is
 * written in its first frame and captured exactly (measured: 28, on every run
 * and both engines), so this is an unmistakable margin under a value that is
 * always there. The contract is the direction the two pages travel in; how far
 * they got is the transition's own business, pinned where `PAGE_SHIFT` is.
 */
const MOVED = 8;

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
  const seenDown = JSON.stringify(down);
  expect(down["/stats"], `统计 arrives from below — saw ${seenDown}`).toBeGreaterThan(MOVED);
  // The outgoing page carries on upward. Only its *direction* is asserted, and
  // only against the other way: an exit lasts 150ms, and a loaded runner can
  // spend the whole of it mounting the page arriving next — on CI the outgoing
  // page was written exactly one value, -1 of its -28, before it was removed.
  // Nothing can require a machine to draw a frame it has no time to draw; what
  // is never allowed is the outgoing page travelling the way the incoming one
  // does, which is what "no direction at all" looks like — a missing `custom`
  // on `AnimatePresence` produces exactly that (measured: +28 instead of -28).
  expect(down["/"] ?? 0, `书库 must not leave downward — saw ${seenDown}`).toBeLessThanOrEqual(0);
  await page.waitForTimeout(300);

  // Up the list: mirrored, or the two pages would read as moving together.
  const up = await swapOffsets(page, "书库");
  const seenUp = JSON.stringify(up);
  expect(up["/"], `书库 arrives from above — saw ${seenUp}`).toBeLessThan(-MOVED);
  expect(up["/stats"] ?? 0, `统计 must not leave upward — saw ${seenUp}`).toBeGreaterThanOrEqual(0);
});
