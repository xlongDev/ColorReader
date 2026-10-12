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
 *
 * 🔴 The sheet is **not** in the document at startup any more: 582 rules
 * (539 KB) load on the reader picking 霞鹜文楷 (`useBundledFont`). So this
 * picks the font first and waits for `document.fonts` to report the family —
 * reading the counters at startup would only measure the laziness. `document.fonts`
 * only lists faces the engine has *parsed*, so its growing is the signal that
 * the sheet arrived, and it is the same signal a real reader waits for.
 */
test("霞鹜文楷 is held back rather than swapped in", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: /我们为什么会生病/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "霞鹜文楷" }).first().click();

  const faces = await page.evaluate(async () => {
    const count = () => {
      const out: Record<string, number> = {};
      for (const face of document.fonts) {
        const family = face.family.replace(/["']/g, "").trim();
        if (family !== "LXGW WenKai") continue;
        out[face.display] = (out[face.display] ?? 0) + 1;
      }
      return out;
    };
    // The sheet arrives as a separate stylesheet, so poll the engine's own
    // view of it rather than sleeping a guessed interval.
    for (let i = 0; i < 40; i += 1) {
      const seen = count();
      if ((seen.block ?? 0) > 0) return seen;
      await new Promise((done) => setTimeout(done, 150));
    }
    return count();
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
