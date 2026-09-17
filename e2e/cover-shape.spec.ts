import { expect, test, type Locator } from "@playwright/test";

/**
 * A cover is one shape at every size.
 *
 * The shelf's grid tile is the reference: 18px on a 138px cover, about 13% of
 * the width. Everything smaller that is still a book cover is cornered to that
 * ratio, because the panel radius scale does not survive the shrink — at 27px
 * wide the reader header's old 14px was past half the box, so the CSS clamp
 * took over and painted the thumbnail as a *capsule*. Not a value anyone chose,
 * and the one shape the flight cannot match at both ends: the corner is scaled
 * with the box, so an origin that is a capsule lands as a capsule.
 *
 * `?demo=1` supplies the sample books, so this runs without the Tauri backend.
 */
const size = (cover: Locator) =>
  cover.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      w: box.width,
      h: box.height,
      radius: Number.parseFloat(getComputedStyle(el).borderTopLeftRadius),
    };
  });

test("every cover keeps the shelf tile's corner ratio", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();

  const tile = await size(page.locator("[data-book-cover]").first());
  const ratio = tile.radius / tile.w;
  expect(ratio, "the tile is the reference, 18px on a 138px cover").toBeCloseTo(0.13, 2);

  // The 续读 card's cover: the other origin a flight can start from. It carries
  // no `data-book-cover` (a name match would land on it before the grid tile),
  // so it is reached through the card.
  const carriedCover = shelf.locator("button").first().locator("img").first().locator("xpath=..");
  const carried = await size(carriedCover);
  expect(
    Math.abs(carried.radius / carried.w - ratio),
    `the 续读 cover is cornered to ${carried.radius} on ${Math.round(carried.w)} (tile ratio ${ratio.toFixed(3)})`,
  ).toBeLessThan(0.01);

  await page.locator("[data-book-cover]").first().click();
  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });

  // The reader is mounted twice for a moment as it enters — two headers, one
  // still settling from the entrance offset — so wait for the one that stays.
  const headerCover = page.locator("[data-header-cover]");
  await expect(headerCover).toHaveCount(1);

  const thumb = await size(headerCover);
  expect(
    thumb.radius,
    "under half the width: past that the CSS clamp is drawing the corner, not us",
  ).toBeLessThan(thumb.w / 2);
  expect(
    Math.abs(thumb.radius / thumb.w - ratio),
    `the header thumbnail is cornered to ${thumb.radius} on ${Math.round(thumb.w)} (tile ratio ${ratio.toFixed(3)})`,
  ).toBeLessThan(0.01);

  // And the 续读 card still opens the book. It is the only way in that goes
  // through a different handler, and one that a rename silently pointed at the
  // file dialog instead — the compiler allowed it, because the dialog takes an
  // optional options object, and nothing else clicked that card.
  await page.getByRole("button", { name: "返回书库" }).first().click();
  await expect(shelf).toBeVisible({ timeout: 10_000 });
  await carriedCover.click();
  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });
});
