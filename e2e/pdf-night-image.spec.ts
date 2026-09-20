import { expect, test, type Page } from "@playwright/test";

/**
 * Night mode has to invert a PDF's images without deleting them.
 *
 * The demo PDF's page 1 carries a saturated orange block, which makes the two
 * failure modes visible in one pixel:
 *
 *  - not inverted at all — the pixel keeps its chroma and glares on dark paper;
 *  - inverted but misplaced — the block reads as bare paper, which is what a
 *    wrong `drawImage` arity looks like from the outside (pdf.js always emits
 *    the eight-number form, and reading it as the four-number one sizes the
 *    copy from the *source* rect: a bitmap with few pixels stretched wide
 *    collapses to a dot and the page looks blank).
 */

/** Centre of the orange block, and a corner that is always bare paper. Both as
 *  fractions of the page box, so the numbers survive a change of zoom. */
const IMAGE = { fx: 100 / 420, fy: 465 / 595 };
const PAPER = { fx: 0.02, fy: 0.02 };

type Rgb = [number, number, number];

const readPixel = (page: Page, fx: number, fy: number): Promise<Rgb> =>
  page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelector('[data-pdf-page="1"] canvas') as HTMLCanvasElement;
      const [r = 0, g = 0, b = 0] = canvas
        .getContext("2d")!
        .getImageData(Math.round(canvas.width * x!), Math.round(canvas.height * y!), 1, 1).data;
      return [r, g, b] as Rgb;
    },
    [fx, fy],
  );

const brightness = ([r, g, b]: Rgb) => (r + g + b) / 3;
const chroma = ([r, g, b]: Rgb) => Math.max(r, g, b) - Math.min(r, g, b);

test("inverts the demo PDF's image without erasing the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&pdf=1");
  await page.getByRole("button", { name: "PDF 样书" }).first().click();
  await expect(page.locator('[data-pdf-page="1"]')).toHaveAttribute(
    "data-pdf-raster",
    /^(cached|rendered)$/,
    { timeout: 15_000 },
  );

  const before = await readPixel(page, IMAGE.fx, IMAGE.fy);
  // Sanity on the fixture: the block is there and it is saturated.
  expect(chroma(before)).toBeGreaterThan(40);

  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: "图片反色", exact: true }).click();
  await page.keyboard.press("Escape");

  // Polled rather than waited on: the re-render keeps the old bitmap on screen
  // until the new one lands, so the pixel itself is the only signal that the
  // reader is looking at the inverted page.
  await expect
    .poll(async () => chroma(await readPixel(page, IMAGE.fx, IMAGE.fy)) < chroma(before) / 3, {
      timeout: 15_000,
    })
    .toBe(true);

  const after = await readPixel(page, IMAGE.fx, IMAGE.fy);
  const paper = await readPixel(page, PAPER.fx, PAPER.fy);
  // The point of the whole exercise: the block came out grey *and stayed
  // visible*. A copy that landed in the wrong place leaves bare paper here,
  // which is exactly what a misread `drawImage` arity looks like.
  expect(brightness(after) - brightness(paper)).toBeGreaterThan(12);

  // And the page around it is still drawn: a render that aborted part-way, or
  // a copy that painted over everything, would leave no ink behind.
  const ink = await page.evaluate(() => {
    const canvas = document.querySelector('[data-pdf-page="1"] canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const corner = ctx.getImageData(
      Math.round(canvas.width * 0.02),
      Math.round(canvas.height * 0.02),
      1,
      1,
    ).data;
    const floor = (corner[0]! + corner[1]! + corner[2]!) / 3;
    let lit = 0;
    for (let i = 1; i < 20; i++) {
      for (let j = 1; j < 20; j++) {
        const d = ctx.getImageData(
          Math.round((canvas.width * i) / 20),
          Math.round((canvas.height * j) / 20),
          1,
          1,
        ).data;
        if ((d[0]! + d[1]! + d[2]!) / 3 > floor + 60) lit += 1;
      }
    }
    return lit;
  });
  expect(ink).toBeGreaterThan(0);
});
