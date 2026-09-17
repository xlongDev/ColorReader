import { expect, test } from "@playwright/test";

/**
 * Leaving the reader: the cover goes home and the shelf keeps its place.
 *
 * Opening a book flies its cover from the shelf tile into the reader's header
 * (`BookCoverFlight`); leaving used to drop it on the floor — the tile was not
 * in the DOM yet when the reader unmounted, so the handoff was simply not
 * started, and the cover vanished while the reader landed at the top of a shelf
 * they had scrolled halfway down. Both halves are asserted here because both
 * are invisible to the unit suite: they only exist across a route change.
 *
 * `?demo=1` supplies three sample books so the reader is reachable without the
 * Tauri backend.
 */
test("leaving the reader flies the cover home and restores the shelf's place", async ({ page }) => {
  // Short enough that three sample books overflow the shelf, which is what
  // makes the scroll half of this test mean anything.
  await page.setViewportSize({ width: 1280, height: 340 });
  await page.goto("/?demo=1");

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();
  const overflow = await shelf.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the shelf has to be scrollable for this test to bite").toBeGreaterThan(40);

  // The grid tile, not the 续读 card above it: that one carries a cover of its
  // own — a differently-rounded one — and shares the book's name, so a bare
  // name match lands on it first.
  const tile = page
    .locator("button:has([data-book-cover])")
    .filter({ hasText: /我们为什么会生病/ })
    .first();

  // Clicked by coordinate, not by locator: Playwright scrolls a located element
  // into view before clicking it, which would move the very position this test
  // is about (the diagnostic run showed it landing at 175 instead of 40). The
  // band is scrolled so that the tile's cover, not the 续读 card, is what sits
  // under the point — they are rounded differently (18px against 14px), and
  // which one the flight picks up is exactly what is asserted below.
  const point = await shelf.evaluate((el) => {
    const band = el.getBoundingClientRect();
    const cover = el.querySelector("[data-book-cover]") as HTMLElement;
    const box = cover.getBoundingClientRect();
    el.scrollTop += box.top + box.height / 2 - (band.top + band.height / 2);
    const moved = cover.getBoundingClientRect();
    const x = moved.left + moved.width / 2;
    const y = moved.top + moved.height / 2;
    return {
      x,
      y,
      onCover: document.elementFromPoint(x, y)?.closest("[data-book-cover]") !== null,
      radius: getComputedStyle(cover).borderTopLeftRadius,
    };
  });
  expect(point.onCover, "a tile cover has to be under the point clicked").toBe(true);
  expect(point.radius, "the tile, not the 续读 card").toBe("18px");

  const left = await shelf.evaluate((el) => el.scrollTop);
  expect(left).toBeGreaterThan(0);

  // Everything below is sampled inside the page rather than asserted from the
  // outside, because three of the things under test live for a third of a
  // second: a flight is 420 ms, and the duplicate page it was drawn with only
  // lasted the length of an exit. A polling assertion loses that race as soon
  // as the suite runs both engines at once — it did.
  //
  // The duplicates: `AnimatePresence` keeps rendering the child it is sending
  // out, and a nested `<Outlet/>` in it re-resolves against the route that just
  // arrived — so the outgoing page *was* the incoming page, mounted twice for
  // the length of the exit (measured: two `ReaderPage`s from one commit, the
  // spare unmounting 229 ms later). The shelf did the same on the way back,
  // which is exactly why a cover looked redrawn just after a flight landed: two
  // copies of the tile were cross-fading ten pixels apart. AppShell renders
  // `useOutlet()` instead, and this is what holds that in place.
  await page.evaluate((flightSelector) => {
    const w = window as unknown as {
      peakCounts?: Record<string, number>;
      flightRadius?: string | null;
      flightSamples?: number;
      lastLanding?: { flight: string; tile: string } | null;
    };
    w.peakCounts = {};
    w.flightRadius = null;
    w.flightSamples = 0;
    w.lastLanding = null;
    const rect = (el: Element) => {
      const b = el.getBoundingClientRect();
      return `${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    };
    const sample = () => {
      for (const selector of ["[data-header-cover]", "[data-shelf-scroller]"]) {
        w.peakCounts![selector] = Math.max(
          w.peakCounts![selector] ?? 0,
          document.querySelectorAll(selector).length,
        );
      }
      const flight = document.querySelector(flightSelector);
      if (!flight) return;
      w.flightSamples = (w.flightSamples ?? 0) + 1;
      w.flightRadius ??= getComputedStyle(flight).borderTopLeftRadius;
      // Where the flight is, next to where the tile it is aiming at is. They
      // have to agree at the end: the destination's box is registered while its
      // page is still settling from its own entrance, so a one-shot reading
      // leaves the flight landing 9px low and the tile then hops up into place.
      const cover = document.querySelector("[data-book-cover]");
      if (cover) w.lastLanding = { flight: rect(flight), tile: rect(cover) };
    };
    sample();
    window.setInterval(sample, 16);
  }, "[data-cover-flight]");

  await page.mouse.click(point.x, point.y);

  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600);

  await page.getByRole("button", { name: "返回书库" }).first().click();

  // Landed: the flight ends the handoff and the tile reveals its own cover.
  await expect(tile.locator("[data-book-cover]")).toHaveCSS("opacity", "1");

  // Back where it was left, not at the top. Within a pixel: this test parks the
  // shelf by adding a computed centre offset to `scrollTop`, so the position it
  // compares against is fractional while the restored one is whole.
  await expect
    .poll(async () => Math.abs((await shelf.evaluate((el) => el.scrollTop)) - left))
    .toBeLessThanOrEqual(1);

  const watched = await page.evaluate(() => {
    const w = window as unknown as {
      peakCounts?: Record<string, number>;
      flightRadius?: string | null;
      flightSamples?: number;
      lastLanding?: { flight: string; tile: string } | null;
    };
    return {
      peak: w.peakCounts,
      radius: w.flightRadius,
      samples: w.flightSamples ?? 0,
      landing: w.lastLanding ?? null,
      flying: document.querySelectorAll("[data-cover-flight]").length,
    };
  });

  expect(watched.samples, "a flight has to have been seen in the air").toBeGreaterThan(3);
  expect(watched.flying, "and it has to be over").toBe(0);
  // The flight wears the corner of the cover it left: it sits exactly on the
  // tile while the tile stops showing its own, so a radius of its own would
  // read as a second, differently-rounded edge for the length of the handoff.
  expect(watched.radius, "the corner of the flight came from the tile").toBe(point.radius);
  expect(watched.peak?.["[data-header-cover]"], "one reader at a time").toBe(1);
  expect(watched.peak?.["[data-shelf-scroller]"], "one shelf at a time").toBe(1);
  // And it arrives where the tile actually is. A box read once, while the shelf
  // was still rising out of its entrance, put the two 9px apart and the cover
  // hopped into place when the flight let go.
  expect(watched.landing, "a landing was sampled").not.toBeNull();
  const xy = (pair: string): [number, number] => {
    const [x = 0, y = 0] = pair.split(",").map(Number);
    return [x, y];
  };
  const [flightX, flightY] = xy(watched.landing?.flight ?? "0,0");
  const [tileX, tileY] = xy(watched.landing?.tile ?? "0,0");
  expect(Math.abs(flightX - tileX), "landed on the tile, x").toBeLessThan(1.5);
  expect(Math.abs(flightY - tileY), "landed on the tile, y").toBeLessThan(1.5);
});

/**
 * The same handoff, with the reader taking over mid-flight.
 *
 * The shelf is live while its cover is in the air. Reporting the landing box on
 * every frame the destination moved meant a *scroll* re-targeted the flight
 * every frame — and a transition whose target changes restarts its duration, so
 * the cover chased the tile up out of the shelf and over the page header
 * (reported, with a screenshot, as the cover "running away upwards"). The
 * flight is aimed once now, so a scroll under it cannot move it.
 */
test("a scroll under a flight home does not drag the flight with it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Enough books to leave the shelf scrollable — the three sample books are not,
  // at this height.
  await page.goto("/?demo=1&books=24");

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();

  await page.locator("[data-book-cover]").first().click();
  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600);

  // Sampled inside the page: a flight lives 420ms, and by the time an outer
  // assertion could look, the box it was aiming at is already gone.
  await page.evaluate(() => {
    const w = window as unknown as {
      aim?: { flight: number; tileAtLaunch: number | null; tileNow: number | null };
    };
    w.aim = { flight: 0, tileAtLaunch: null, tileNow: null };
    const sample = () => {
      const flight = document.querySelector("[data-cover-flight]");
      const tile = document.querySelector("[data-book-cover]");
      if (!flight || !tile) return;
      w.aim!.flight = Math.round(flight.getBoundingClientRect().y);
      const y = Math.round(tile.getBoundingClientRect().y);
      w.aim!.tileAtLaunch ??= y;
      w.aim!.tileNow = y;
    };
    sample();
    window.setInterval(sample, 16);
  });

  await page.getByRole("button", { name: "返回书库" }).first().click();
  // A beat into the flight, then scroll the shelf out from under it.
  await page.waitForTimeout(140);
  const scrolled = await shelf.evaluate((el) => {
    el.scrollTop += 260;
    return el.scrollTop;
  });
  expect(scrolled, "the shelf has to actually scroll").toBeGreaterThan(200);

  await expect(page.locator("[data-cover-flight]")).toHaveCount(0, { timeout: 5_000 });

  const aim = await page.evaluate(
    () =>
      (
        window as unknown as {
          aim: { flight: number; tileAtLaunch: number | null; tileNow: number | null };
        }
      ).aim,
  );
  expect(aim?.tileAtLaunch ?? null, "a flight has to have been sampled").not.toBeNull();
  // The tile moved a long way; the flight did not follow it.
  expect(
    Math.abs((aim?.tileNow ?? 0) - (aim?.tileAtLaunch ?? 0)),
    "the shelf really moved the tile",
  ).toBeGreaterThan(200);
  expect(
    Math.abs((aim?.flight ?? 0) - (aim?.tileAtLaunch ?? 0)),
    "and the flight stayed on the aim it had",
  ).toBeLessThanOrEqual(2);
});

/**
 * And when the reader is the one scrolling, the flight yields.
 *
 * A flight home lands on the slot its tile had, so a *real* scroll under it has
 * to end it: otherwise the cover lands on a slot its tile has since left and
 * hops the difference (measured: 59px of hop for a 60px scroll, at the instant
 * the handoff ended — after the eye had followed the cover all the way). It is
 * dropped at the gesture instead, where the whole shelf is moving anyway.
 */
test("scrolling the shelf mid-flight hands the cover straight back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&books=24");

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();

  await page.locator("[data-book-cover]").first().click();
  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600);

  // Counting starts at the wheel, so what it measures is the flight's survival.
  await page.evaluate(() => {
    const w = window as unknown as { after?: { counting: boolean; frames: number; cover: string } };
    w.after = { counting: false, frames: 0, cover: "" };
    const sample = () => {
      if (!w.after!.counting) return;
      if (document.querySelector("[data-cover-flight]")) w.after!.frames += 1;
      const cover = document.querySelector("[data-book-cover]");
      if (cover) w.after!.cover = getComputedStyle(cover).opacity;
    };
    window.setInterval(sample, 16);
  });

  await page.getByRole("button", { name: "返回书库" }).first().click();
  // A beat into the flight, then a real wheel over the shelf.
  await page.waitForTimeout(150);
  const band = await shelf.boundingBox();
  if (!band) throw new Error("the shelf has to have a box");
  await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2);
  await page.mouse.wheel(0, 60);
  await page.evaluate(() => {
    const w = window as unknown as { after: { counting: boolean } };
    w.after.counting = true;
  });
  await page.waitForTimeout(700);

  const after = await page.evaluate(
    () => (window as unknown as { after: { frames: number; cover: string } }).after,
  );
  // Gone within a frame or two of the gesture — not the ~350ms it had left.
  expect(after.frames, "the flight does not outlive the scroll").toBeLessThanOrEqual(3);
  // And its tile is showing its own cover again.
  expect(after.cover, "the cover is back on its tile").toBe("1");
});
