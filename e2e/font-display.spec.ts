import { expect, test } from "@playwright/test";

/**
 * 霞鹜文楷 is held back rather than swapped in.
 *
 * "从别的字体切换成霞鹜文楷的时候,页面字体先会变成楷体再变成霞鹜文楷" is what
 * `font-display: swap` looks like from the reader's chair: the book paints in
 * 楷体 — the next family in the stack — and changes under them when the
 * subsets land. The webfont package authors every one of its subsets as
 * `swap`, so the app rewrites them to `block` in `vite.config.ts`, and this
 * asserts the rewrite reached the built sheet.
 *
 * It is the app document that is checked, which is the surface a `.txt` book
 * renders in. A foliate section is a document of its own and gets its rules
 * from `bundledFontFaces` instead; the two are covered by the same descriptor
 * and the same rewrite, and the section path was measured separately with the
 * font held back at the network layer — the shipped rules drew no ink where
 * `swap` drew the fallback face.
 *
 * `FontFace.display` is the descriptor as the engine parsed it, so this fails
 * if the plugin is dropped, if the package is upgraded into a sheet that
 * bypasses PostCSS, or if the family stops loading altogether.
 */
test("霞鹜文楷 is held back rather than swapped in", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  const faces = await page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const face of document.fonts) {
      const family = face.family.replace(/["']/g, "").trim();
      if (family !== "LXGW WenKai") continue;
      out[face.display] = (out[face.display] ?? 0) + 1;
    }
    return out;
  });

  // 291 subsets today. Not pinned exactly, because the number belongs to the
  // package and a bump would fail this for no reason — what matters is that
  // the family is present at all and that not one rule still swaps.
  expect(
    faces.block ?? 0,
    `the sheet has to declare the family (saw ${JSON.stringify(faces)})`,
  ).toBeGreaterThan(0);
  expect(
    faces.swap,
    `a swapping subset is the reader watching 楷体 arrive first (saw ${JSON.stringify(faces)})`,
  ).toBeUndefined();
});
