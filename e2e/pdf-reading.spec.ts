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
 * Mirrors `PREFETCH_SETTLE_MS` in `PdfPageView.tsx`: how long the page must sit
 * still before the next one is rasterised behind the reader's back. Duplicated
 * rather than imported on purpose — the e2e suite has no view of a module's
 * constants, and a budget that silently forgets the settle is worse than one
 * that has to be updated alongside it.
 */
const PREFETCH_SETTLE_MS = 300;

/**
 * What one raster may cost. `PdfPageView` documents 90–150 ms for an
 * illustrated page, which is a machine with a GPU; CI has none and shares two
 * cores with the rest of the suite, so this is ~20× that and is an allowance
 * rather than a deadline. A prefetch that never lands still fails — only later,
 * which is the point: nothing here can turn a cold turn into a warm one.
 */
const RASTER_ALLOWANCE_MS = 2500;

/**
 * Lets the prefetch run, and waits for the link that arms it.
 *
 * `PdfPageView` schedules the prefetch as the *last* thing its render does —
 * after the page's own raster, and after the text layer it builds over the
 * canvas — then waits `PREFETCH_SETTLE_MS`, then rasterises. So the chain has
 * three links and only one of them has a witness in the DOM: the text layer,
 * which is the element that same render fills. Waiting for it is what leaves a
 * budget instead of a hope, because the layer is also the slowest and the most
 * variable of the three, and it had been assumed rather than seen.
 *
 * Measured (webkit, fixture PDF, 1280×820): with every layer already built the
 * spread is warm 200–400 ms later. The flat 900 ms this replaces had to cover
 * the layers as well as the settle and the raster, and it overran on CI twice
 * — once on a runner whose install phase had degraded 50×, and once on a
 * perfectly healthy one (e2e 20m01s against 19m54s the run before), which is
 * what says the budget was wrong rather than the machine. When it overruns the
 * second half of the spread rasterises for real.
 *
 * Every page view on screen is waited for, not a fixed count: in double-page
 * mode each half arms its own prefetch, and after a turn the views are
 * different pages, so counting from one would wait for a layer that is no
 * longer mounted.
 */
async function letPrefetchSettle(page: Page) {
  const views = page.locator("[data-pdf-page]");
  for (let i = 0; i < (await views.count()); i++) {
    await expect(views.nth(i).locator("[data-pdf-layer]")).not.toBeEmpty({ timeout: 20_000 });
  }
  await page.waitForTimeout(PREFETCH_SETTLE_MS + RASTER_ALLOWANCE_MS);
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

/**
 * The turn overlay, counted as it happens.
 *
 * The overlay exists for one animation and is gone before a locator can poll
 * for it, so the only witness that works is an observer installed before the
 * key is pressed. What it has to establish is that the *real* turn path builds
 * one at all: it is made of a selector (`[data-pdf-page] canvas`) and a
 * measured box, and a wrong one silently produces nothing — the page still
 * turns, just without the animation, which is exactly how the paged PDF
 * behaved before this existed.
 */
type TurnWitness = { count: number; canvases: number; curl: boolean };

async function watchTurns(page: Page) {
  await page.evaluate(() => {
    const host = document.querySelector("[data-reading-viewport]");
    if (!host) throw new Error("没有阅读视口");
    const seen: TurnWitness = { count: 0, canvases: 0, curl: false };
    (window as unknown as { turnWitness: TurnWitness }).turnWitness = seen;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.hasAttribute("data-pdf-turn")) {
            seen.count += 1;
            seen.canvases = node.querySelectorAll("canvas").length;
            seen.curl = node.querySelector("[data-pdf-curl]") !== null;
          }
        }
      }
    }).observe(host, { childList: true });
  });
}

function turnSeen(page: Page): Promise<TurnWitness> {
  return page.evaluate(() => (window as unknown as { turnWitness: TurnWitness }).turnWitness);
}

/**
 * One horizontal wheel event over the reading area — a trackpad nudge, without
 * the burst of inertial events a real swipe (or Playwright's `mouse.wheel`)
 * carries, so a test can say exactly how far the sheet was dragged.
 */
async function swipe(page: Page, deltaX: number) {
  await page.evaluate((distance) => {
    const el = document.querySelector("[data-reading-content]");
    el?.dispatchEvent(
      new WheelEvent("wheel", { deltaX: distance, deltaY: 0, bubbles: true, cancelable: true }),
    );
  }, deltaX);
}

/** Picks a page-turn style the way a reader would. */
async function setTransition(page: Page, label: string) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.keyboard.press("Escape");
}

test("the paper turn bends the sheet on the GPU, and leaves nothing behind", async ({ page }) => {
  await openPdf(page, "单页");
  await setTransition(page, "仿真");
  await letPrefetchSettle(page);

  // Which renderer runs is decided by whether this engine hands out a WebGL
  // context at all, so the assertion is the two of them agreeing rather than
  // one fixed answer. A shader that fails to compile would fall back to the
  // flat fold silently — and show up here as a mismatch.
  const webgl = await page.evaluate(() => {
    const probe = document.createElement("canvas");
    return probe.getContext("webgl") !== null;
  });
  await watchTurns(page);

  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });

  const seen = await turnSeen(page);
  expect(seen.count).toBe(1);
  expect(seen.curl).toBe(webgl);

  await expect(page.locator("[data-pdf-turn]")).toHaveCount(0);
});

test("a swipe too short to finish springs the sheet back instead of turning", async ({ page }) => {
  await openPdf(page, "单页");
  await setTransition(page, "仿真");
  await letPrefetchSettle(page);

  // Past the travel that starts a turn, nowhere near far enough to finish one.
  // Before the wheel could hold a sheet this turned the page outright: any
  // swipe past 48px was a page, whatever the reader meant by it.
  // One nudge: past the travel that starts a turn, nowhere near far enough to
  // finish one. Dispatched as a single event rather than through
  // `mouse.wheel`, which arrives as a burst with the browser's own inertia
  // on top of it and would carry the sheet past the point of no return.
  await swipe(page, 120);
  await page.waitForTimeout(700);

  await expect(pageView(page, 1)).toBeVisible();
  // ...and it left nothing on top of the page it gave back.
  await expect(page.locator("[data-pdf-turn]")).toHaveCount(0);
});

test("a swipe that carries the sheet far enough turns the page", async ({ page }) => {
  await openPdf(page, "单页");
  await setTransition(page, "仿真");
  await letPrefetchSettle(page);
  await watchTurns(page);

  // Far enough to carry the sheet past the point of no return.
  await swipe(page, 600);
  await page.waitForTimeout(900);

  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", /^(cached|rendered)$/, {
    timeout: 10_000,
  });
  expect((await turnSeen(page)).count).toBe(1);
  await expect(page.locator("[data-pdf-turn]")).toHaveCount(0);
});

test("a paged PDF turn animates the page it is leaving, then clears it away", async ({ page }) => {
  await openPdf(page, "单页");
  await letPrefetchSettle(page);
  await watchTurns(page);

  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });

  // One overlay, carrying the one page that was on screen.
  const seen = await turnSeen(page);
  expect(seen.count).toBe(1);
  expect(seen.canvases).toBe(1);

  // ...and it does not outlive the turn: an overlay left behind would swallow
  // every click and every selection on the page underneath it.
  await expect(page.locator("[data-pdf-turn]")).toHaveCount(0);
});

test("a reduced-motion turn puts no overlay on the page", async ({ page, browser }) => {
  // Two contexts, not two halves of one page: the reader reads the motion
  // preference once, as initial state, so a page that has already mounted
  // never follows `emulateMedia` changing under it.
  //
  // The unreduced context is the control. A test that only ever ran under the
  // preference would pass just as well against a turn that animates nothing at
  // all — which is what a paged PDF did before this existed.
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const still = await context.newPage();
  await openPdf(still, "单页");
  await letPrefetchSettle(still);
  await watchTurns(still);

  await still.keyboard.press("ArrowRight");
  await expect(pageView(still, 2)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });
  expect((await turnSeen(still)).count).toBe(0);
  await context.close();

  await openPdf(page, "单页");
  await letPrefetchSettle(page);
  await watchTurns(page);

  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });
  expect((await turnSeen(page)).count).toBe(1);
});

test("a theme change repaints the page instead of reusing the paper it was rasterised on", async ({
  page,
}) => {
  await openPdf(page, "单页");

  // Starts on 原色: `pdfNight` is `follow` and the page is a day page, so the
  // file shows the colours it was published with. Pinned to the night axis for
  // the duration — which is what the reader would have to do to see a dark
  // PDF — so the flip under test is the one between the two rasters.
  //
  // Asserted as "the paper changed" rather than by a fixed colour: what
  // matters here is that flipping the axis repaints, and that the next turn
  // follows. Naming the axis would pin a default this file is not about.
  expect(await paper(page, 1)).toBe("light");

  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: "夜间反色", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => paper(page, 1)).toBe("dark");
  await letPrefetchSettle(page);

  // Back to 原色 — the state a day page follows to.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: "原色", exact: true }).click();
  await page.keyboard.press("Escape");

  await expect.poll(() => paper(page, 1)).toBe("light");
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

test("a PDF on 跟随主题 is re-inked by the theme and only by the theme", async ({ page }) => {
  await openPdf(page, "单页");

  // The default, and the promise the setting makes: a document shows its own
  // colours in the day, and is darkened for a reader who works at night —
  // without anyone going into the panel to say so.
  expect(await paper(page, 1)).toBe("light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => paper(page, 1)).toBe("dark");
  await letPrefetchSettle(page);

  // The turn follows the axis the page is on now, not the one it opened on.
  await page.keyboard.press("ArrowRight");
  await expect(pageView(page, 2)).toHaveAttribute("data-pdf-raster", "cached", {
    timeout: 10_000,
  });
  expect(await paper(page, 2)).toBe("dark");

  await page.emulateMedia({ colorScheme: "light" });
  // Back to 原色, and the page on screen is the one being repainted — the
  // reader is on page 2 now, so that is the canvas whose axis has to flip.
  await expect.poll(() => paper(page, 2)).toBe("light");
});

test("a PDF pinned to 原色 keeps it while the theme turns", async ({ page }) => {
  await openPdf(page, "单页");

  // The other half of the promise: 跟随 is a *default*, not a rule. A reader
  // who reads a book whose colours matter can hold it there, and the theme
  // then changes the chrome and nothing else.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: "原色", exact: true }).click();
  await page.keyboard.press("Escape");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  expect(await paper(page, 1)).toBe("light");
});
