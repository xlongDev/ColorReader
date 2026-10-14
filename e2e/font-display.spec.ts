import { expect, test, type Page } from "@playwright/test";

/**
 * A font the reader installs is held back rather than swapped in.
 *
 * "从别的字体切换成霞鹜文楷的时候,页面字体先会变成楷体再变成霞鹜文楷" is what
 * `font-display: swap` looks like from the reader's chair: the book paints in
 * 楷体 — the next family in the stack — and changes under them when the subsets
 * land. Both webfont packages author every subset as `swap`, so the app
 * rewrites them to `block` as it adopts the sheet (`withBlockDisplay`), and
 * this asserts the rewrite reached the engine's own view of the rules.
 *
 * It is the app document that is checked, which is where an adopted sheet
 * lands. A foliate section is a document of its own and gets its rules from
 * `adoptedFontFaces` instead; the two are covered by the same descriptor and
 * the same rewrite, and the section path was measured separately with the font
 * held back at the network layer — the shipped rules drew no ink where `swap`
 * drew the fallback face.
 *
 * `FontFace.display` is the descriptor as the engine parsed it, so this fails
 * if the rewrite is dropped or if a package is upgraded into a sheet that
 * bypasses it. 霞鹜文楷 is the subject rather than Noto Serif SC because its
 * stack falls through to 楷体, which is the flash the report above describes.
 *
 * 🔴 The sheet is **not** in the document at startup: nothing ships a font, so
 * it arrives when the reader installs one. This installs first and waits for
 * `document.fonts` to report the family — reading the counters at startup would
 * only measure the absence. `document.fonts` lists the faces the engine has
 * *parsed*, so its growing is the signal that the sheet arrived, and it is the
 * same signal a real reader waits for.
 */

/** The sheets `src/lib/fontCatalog.ts` pins, served from the fixtures it pins
 *  them to — the hash check stays in the path either way. */
async function installLxgw(page: Page): Promise<void> {
  await page.route("**/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-*.css", (route) => {
    const weight = route.request().url().includes("bold") ? "bold" : "regular";
    void route.fulfill({
      path: `e2e/fixtures/font-catalog/lxgw-${weight}.css`,
      contentType: "text/css",
    });
  });
  // The glyph stream is the browser's job and is not what this pins; the
  // sheets are, and the engine parses a family out of them without any subset
  // ever arriving.
  await page.route("**/files/lxgwwenkai-*.woff2", (route) => route.abort());

  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "字体", exact: true }).click();
  await page.getByRole("button", { name: "下载 霞鹜文楷" }).click();
  await expect(page.getByText("「霞鹜文楷」已安装，可以在阅读器的「字体」里选用。")).toBeVisible({
    timeout: 15_000,
  });
}

test("霞鹜文楷 is held back rather than swapped in", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installLxgw(page);

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
    // The sheet is adopted asynchronously, so poll the engine's own view of it
    // rather than sleeping a guessed interval.
    for (let i = 0; i < 40; i += 1) {
      const seen = count();
      if ((seen.block ?? 0) > 0) return seen;
      await new Promise((done) => setTimeout(done, 150));
    }
    return count();
  });

  // Not pinned exactly, because the number belongs to the package and a bump
  // would fail this for no reason — what matters is that the family is present
  // at all and that not one rule still swaps.
  expect(
    faces.block ?? 0,
    `the sheet has to declare the family (saw ${JSON.stringify(faces)})`,
  ).toBeGreaterThan(0);
  expect(
    faces.swap,
    `a swapping subset is the reader watching 楷体 arrive first (saw ${JSON.stringify(faces)})`,
  ).toBeUndefined();
});
