import { expect, test } from "@playwright/test";

/**
 * The shelf reflows as motion when the sidebar changes its width.
 *
 * The grid's tracks are pinned from a render (see `useShelfWindow`) instead of
 * being left to CSS `auto-fill`, and this is why: motion's FLIP snapshots the
 * DOM in `getSnapshotBeforeUpdate`, i.e. *before* React mutates it, and
 * compares that with a measurement taken after. A column change the stylesheet
 * performed on its own has already moved every card by the time the "before"
 * box is taken, so the delta is zero and nothing animates — the shelf
 * teleports. Measured on a 24-book shelf: the re-render happened exactly as
 * intended and every card's `transform` stayed `none` while a tile crossed
 * 170px in a single frame.
 *
 * Two things are asserted, and they fail for different reasons:
 *
 * 1. **The pin is the number `auto-fill` would have picked**, at a spread of
 *    widths, with every track at its full size. This is the assertion that
 *    matters, because the pin can drift *silently*: a grid pinned to one column
 *    too many shrinks its own tracks to fit, and a shrunken track then divides
 *    into the same count it came from. Measured on a 530px pane — 4 tracks
 *    resolved to 117.5px each, `(530 + 20) / (117.5 + 20)` floored back to 4,
 *    and the shelf could not come back from a narrow window. The pin only ever
 *    grew.
 *
 * 2. **A collapse carries a transform.** A re-render that produces no FLIP is
 *    indistinguishable from a working shelf in every other assertion here, so
 *    the motion has to be observed rather than inferred. The check is on the
 *    *translation* of the matrix, well past any scale the tile's own entrance
 *    could contribute — "some transform is running" would be true of a card
 *    that was merely still fading in.
 */
const SHELF = "/?demo=1&books=24";

/**
 * Read the live grid, and what `auto-fill` would have chosen for the same box.
 *
 * The reference is measured in a throwaway element rather than by clearing the
 * live grid's inline style: blanking it and putting it back leaves React
 * believing it already wrote the value, so the DOM and the app disagree from
 * then on — which is how a previous run of this measurement reported four
 * widths as broken that were not.
 */
const probe = () => {
  const grid = document.querySelector("[data-shelf-scroller] .grid") as HTMLElement;
  const scroller = document.querySelector("[data-shelf-scroller]") as HTMLElement;
  const style = getComputedStyle(grid);
  const width = grid.getBoundingClientRect().width;
  const declared = Number.parseFloat(style.getPropertyValue("--shelf-track"));
  const gap = Number.parseFloat(style.columnGap);

  const reference = document.createElement("div");
  reference.style.cssText =
    `position:absolute;left:-99999px;top:0;display:grid;width:${width}px;gap:${gap}px;` +
    `grid-template-columns:repeat(auto-fill,minmax(0,${declared}px))`;
  reference.append(document.createElement("i"));
  document.body.append(reference);
  const auto = getComputedStyle(reference).gridTemplateColumns.split(" ").length;
  reference.remove();

  const tracks = style.gridTemplateColumns.split(" ").map(Number.parseFloat);
  return {
    pinned: tracks.length,
    auto,
    declared,
    narrowest: Math.min(...tracks),
    overflowX: scroller.scrollWidth - scroller.clientWidth,
  };
};

test("the pinned columns are the ones auto-fill would pick, at every width", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 800 });
  await page.goto(SHELF);
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  for (const width of [880, 960, 980, 1080, 1120, 1300, 1440, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(
        async () => {
          const seen = await page.evaluate(probe);
          if (seen.pinned !== seen.auto)
            return `${seen.pinned} tracks pinned, auto-fill wants ${seen.auto}`;
          if (seen.narrowest !== seen.declared)
            return `narrowest track is ${seen.narrowest}, the token says ${seen.declared}`;
          if (seen.overflowX > 0) return `${seen.overflowX}px of horizontal overflow`;
          return "";
        },
        { message: `at ${width}px the pinned tracks are the ones auto-fill would pick` },
      )
      .toBe("");
  }
});

test("collapsing the sidebar reflows the cards instead of teleporting them", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 800 });
  await page.goto(SHELF);
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();
  // The tiles arrive on a stagger, and a tile that is still entering carries a
  // scale. Let the shelf settle so the only transform left to see is the one
  // this test is about.
  await page.waitForTimeout(1000);

  const before = await page.evaluate(
    () =>
      getComputedStyle(
        document.querySelector("[data-shelf-scroller] .grid")!,
      ).gridTemplateColumns.split(" ").length,
  );

  await page.getByRole("button", { name: "折叠侧边栏" }).click();

  // Sampled inside the page, frame by frame: the spring settles in about 700ms
  // and a round trip per frame from the driver would miss most of it.
  const seen = await page.evaluate(async () => {
    const wraps = [...document.querySelectorAll("[data-book-cover]")].map(
      (cover) => cover.closest("button")?.parentElement ?? null,
    );
    let frames = 0;
    let furthest = 0;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      let moved = false;
      for (const wrap of wraps) {
        if (!wrap) continue;
        const match = /matrix\(([^)]+)\)/.exec(getComputedStyle(wrap).transform);
        if (!match) continue;
        const parts = (match[1] ?? "").split(",").map(Number);
        const tx = Math.abs(parts[4] ?? 0);
        const ty = Math.abs(parts[5] ?? 0);
        if (tx > 100 || ty > 100) {
          moved = true;
          furthest = Math.max(furthest, tx, ty);
        }
      }
      if (moved) frames += 1;
    }
    return { frames, furthest: Math.round(furthest) };
  });

  // The gesture has to have been a real one — otherwise "it animated" would be
  // vacuously satisfiable by a shelf that did not reflow at all.
  const after = await page.evaluate(
    () =>
      getComputedStyle(
        document.querySelector("[data-shelf-scroller] .grid")!,
      ).gridTemplateColumns.split(" ").length,
  );
  expect(after, "the sidebar buys a column, so the count has to move").toBeGreaterThan(before);

  expect(
    seen.furthest,
    "the FLIP has to start from the old slot — a teleport leaves no translation at all",
  ).toBeGreaterThan(100);
  expect(
    seen.frames,
    `and it has to be an animation, not a one-frame artifact (furthest translation: ${seen.furthest}px)`,
  ).toBeGreaterThan(3);
});
