import { expect, test, type Page } from "@playwright/test";

/**
 * Reading a PDF.
 *
 * Nothing opened one in this suite before: the browser fixture had no PDF, so
 * every part of this path — rasterising a page into a canvas, building its
 * selectable text layer, the offscreen double buffer that keeps the old page on
 * screen, the prefetch that turns the next page into a blit — was verified by
 * reading alone. Two defects landed in exactly that gap in one evening, both
 * found by a reader rather than by a test:
 *
 * 1. a page turn flashed white, because the wrapper carried `key={chapterIdx}`
 *    and every turn unmounted the canvas;
 * 2. a sidebar spring re-rasterised every page on screen once per frame,
 *    because the width pin foliate and prose already had did not cover PDF.
 *
 * What this file can see that a unit test cannot is the *seam*: whether the
 * raster a prefetch filed under a key is the one the next turn looks for. The
 * two are computed from opposite ends of the same render, and a mismatch is
 * invisible on screen — the page still arrives, just late, which is how the
 * defect it replaces looked.
 *
 * The layout is set explicitly, and it matters. A PDF opens in **scroll**, where
 * `PdfScrollView` mounts the pages around the viewport and needs no prefetch at
 * all; the prefetch belongs to the paged layouts, which is where a reader feels
 * a turn. A spec that left the default alone would pass while exercising none
 * of it — which is what the first draft of this file did.
 *
 * `?demo=1&pdf=1` puts the fixture PDF on the sample shelf: six pages, five of
 * them ordinary text and one a dense vector grid. Nothing here measures time, so
 * that heavy page is for a reader checking the fix by hand rather than for an
 * assertion — every claim below is about *what* was blitted, not how fast.
 */

/**
 * One page's text layer. Scoped to the page root on purpose: during the
 * cross-fade two page views are mounted at once, so a bare `[data-pdf-layer]`
 * matches the page that is leaving as well as the one arriving.
 */
function layerOf(page: Page, n: number) {
  return page.locator(`[data-pdf-page="${n}"] [data-pdf-layer]`);
}

/** A page view, by the page it is showing. */
function pageView(page: Page, n: number) {
  return page.locator(`[data-pdf-page="${n}"]`);
}

/**
 * The paper a page is painted on, read at its top-left corner.
 *
 * pdf.js fills the whole canvas with the paper colour before it draws anything,
 * and the fixture leaves that corner empty, so one pixel answers a binary
 * question with no ambiguity: white paper or the night axis. That contrast is
 * what makes this worth reading at all — a bitmap served from the wrong axis is
 * otherwise invisible to `data-pdf-raster`, which would happily call it
 * `cached`.
 */
async function paper(page: Page, n: number): Promise<"light" | "dark"> {
  return page.evaluate((which) => {
    const canvas = document.querySelector(`[data-pdf-page="${which}"] canvas`);
    const ctx = canvas instanceof HTMLCanvasElement ? canvas.getContext("2d") : null;
    if (!ctx) throw new Error("页面上没有画布");
    const data = ctx.getImageData(2, 2, 1, 1).data;
    const r = data[0]!;
    const g = data[1]!;
    const b = data[2]!;
    return r + g + b > 300 ? "light" : "dark";
  }, n);
}

/**
 * Opens the fixture PDF on `layout` and waits for its first page to be up.
 *
 * `data-pdf-raster` is written when a bitmap is blitted and cleared when a
 * render starts, so waiting for it is waiting for the page itself rather than
 * for a fixed number of milliseconds.
 */
async function openPdf(page: Page, layout: "单页" | "双页") {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&pdf=1");
  await page.getByRole("button", { name: "PDF 样书" }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: layout, exact: true }).click();
  await page.keyboard.press("Escape");

  await expect(pageView(page, 1)).toHaveAttribute("data-pdf-raster", /^(cached|rendered)$/, {
    timeout: 15_000,
  });
}

/**
 * Lets the prefetch run: it waits 300 ms for the page to settle before it
 * starts, then rasterises. This is that budget, not a hope.
 */
async function letPrefetchSettle(page: Page) {
  await page.waitForTimeout(900);
}

test("a paged PDF rasterises into a canvas, and carries its own text layer", async ({ page }) => {
  await openPdf(page, "单页");

  // One page at a time in the single-page layout.
  await expect(page.locator("[data-pdf-page]")).toHaveCount(1);

  // Nothing was on screen before it, so there was nothing to serve it from.
  await expect(pageView(page, 1)).toHaveAttribute("data-pdf-raster", "rendered");

  // The selectable layer is built from the page's own text, not from an image:
  // the fixture's first page says "Page 1" in its heading.
  const layer = layerOf(page, 1);
  await expect(layer).toBeVisible();
  await expect(layer).toContainText("Page 1");
});

test("a single-page turn is served from the prefetched raster", async ({ page }) => {
  await openPdf(page, "单页");
  await letPrefetchSettle(page);

  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });

  // ...and the page it swapped in is the second one, not a stale bitmap.
  await expect(layerOf(page, 2)).toContainText("Page 2");

  // The chain keeps going: the turn after this one is warm too.
  await letPrefetchSettle(page);
  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 3)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });
});

test("a double-page turn warms both halves of the spread", async ({ page }) => {
  await openPdf(page, "双页");

  // A spread is two page views, and a turn advances both.
  await expect(page.locator("[data-pdf-page]")).toHaveCount(2);
  await letPrefetchSettle(page);

  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 3)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });
  await expect(pageView(page, 4)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });
});

test("a turn with no warm raster still lands on the right page", async ({ page }) => {
  await openPdf(page, "单页");

  // No settle: the prefetch has not run, so this turn rasterises for real. It
  // is the path a reader gets whenever they outrun the prefetch, and it has to
  // be indistinguishable on screen.
  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", /^(cached|rendered)$/, {
    timeout: 10_000,
  });
  await expect(layerOf(page, 2)).toContainText("Page 2");
});

test("a theme change repaints the page instead of reusing the paper it was rasterised on", async ({
  page,
}) => {
  await openPdf(page, "单页");

  // A PDF opens on the night axis (`pdfNight` defaults to true), so the paper
  // is already dark. Asserted relationally rather than by name: which axis is
  // on is a default, and what matters here is that flipping it changes the
  // paper and that the next turn follows.
  const before = await paper(page, 1);
  await letPrefetchSettle(page);

  await page.getByRole("button", { name: "阅读设置" }).first().click();
  const nightChip = page.getByRole("button", { name: "夜间反色", exact: true });
  const wasNight = (await nightChip.getAttribute("aria-pressed")) === "true";
  await page.getByRole("button", { name: wasNight ? "原色" : "夜间反色", exact: true }).click();
  await page.keyboard.press("Escape");

  await expect.poll(() => paper(page, 1)).not.toBe(before);
  const after = await paper(page, 1);

  // The turn is warm again, under the axis the page is wearing now.
  await letPrefetchSettle(page);
  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });

  // And it is the paper the reader is looking at, not the one the first
  // prefetch left in the store. A key that omitted the night axis would still
  // say "cached" here and put the other axis's paper on screen — this line is
  // the only thing that sees it.
  expect(await paper(page, 2)).toBe(after);
});
