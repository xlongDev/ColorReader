import { expect, test, type Page } from "@playwright/test";

/**
 * A catalogue font, installed with one click and rendered in a book.
 *
 * The catalogue serves `@font-face` sheets from a public CDN and the glyph
 * subsets stream per `unicode-range` — so this is the one font path that
 * touches the network, and the CDN is intercepted here rather than called for
 * real: the fixtures are the very sheets `src/lib/fontCatalog.ts` pins by
 * sha256, which keeps the run hermetic *and* keeps the hash check in the
 * path (a served file that did not match would fail the install, which is
 * the point of the pin).
 *
 * Noto Serif SC is the subject rather than 霞鹜文楷 on purpose: 霞鹜文楷 has a
 * spec of its own (`font-display.spec.ts`) pinning the engine's view of its
 * rules, and this one is about the journey — install, offer, select, remove.
 * Noto Serif SC has no other way into the app at all: nothing ships a font, so
 * if the reader renders this family the catalogue put it there.
 *
 * The subset `woff2` files are not shipped as fixtures and are answered 404:
 * the glyph stream is the browser's job, and what this pins is the app's own
 * contract — the sheet is installed, the face is offered, the picker selects
 * it, and the engine parses the family into `document.fonts`.
 */

const FIXTURES = "e2e/fixtures/font-catalog";

/** 设置 is a chrome button, not a rail link; the route boots on the shelf. */
async function openFonts(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "字体", exact: true }).click();
}

/** Every family the engine has parsed out of the document's stylesheets. */
async function parsedFamilies(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const seen = () => {
      const out = new Set<string>();
      for (const face of document.fonts) out.add(face.family.replace(/["']/g, "").trim());
      return [...out];
    };
    // The adopted sheet lands asynchronously, so poll the engine's own view
    // rather than sleeping a guessed interval.
    for (let i = 0; i < 40; i += 1) {
      const families = seen();
      if (families.includes("Noto Serif SC")) return families;
      await new Promise((done) => setTimeout(done, 150));
    }
    return seen();
  });
}

test("a catalogue font installs, renders in a book, and uninstalls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  // The two hosts the manifest lists, both serving the pinned sheets.
  await page.route("**/noto-serif-sc@5.3.1/*.css", (route) => {
    const weight = route.request().url().endsWith("/700.css") ? "700" : "400";
    void route.fulfill({
      path: `${FIXTURES}/noto-serif-sc-${weight}.css`,
      contentType: "text/css",
    });
  });
  await page.route("**/files/noto-serif-sc-*.woff2", (route) => route.abort());

  await openFonts(page);
  const row = page.getByText("Noto Serif SC", { exact: true }).first();
  await expect(row).toBeVisible();
  // Named, not just 下载: one catalogue entry per row, each with its own button.
  const install = page.getByRole("button", { name: "下载 Noto Serif SC" });
  await expect(install).toBeVisible();

  await install.click();
  await expect(
    page.getByText("「Noto Serif SC」已安装，可以在阅读器的「字体」里选用。"),
  ).toBeVisible({
    timeout: 15_000,
  });

  // The sheets are adopted into the document: subset URLs absolute (an
  // adopted <style> has no base of its own), and no subset still swapping.
  const adopted = await page.evaluate(() => {
    const style = document.getElementById("catalog-font-noto-serif-sc");
    return {
      present: style !== null,
      text: style?.textContent ?? "",
    };
  });
  expect(adopted.present).toBe(true);
  expect(adopted.text).toContain("font-family: 'Noto Serif SC'");
  expect(adopted.text).not.toContain("./files/");
  expect(adopted.text).not.toContain("font-display: swap");

  // The row now offers removal instead of installation.
  await expect(page.getByRole("button", { name: "删除 Noto Serif SC" })).toBeVisible();

  // The reader: the picker offers the installed face, and selecting it parses
  // the family into the engine. Nothing ships a font, so the family exists
  // here only because the catalogue adopted it.
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
  await page.getByRole("button", { name: "Noto Serif SC", exact: true }).first().click();
  await expect.poll(() => parsedFamilies(page), { timeout: 10_000 }).toContain("Noto Serif SC");

  // And back out: the face leaves the document and the row offers it again.
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page.getByRole("button", { name: "字体", exact: true }).click();
  await page.getByRole("button", { name: "删除 Noto Serif SC" }).click();
  await expect(page.getByText("「Noto Serif SC」已移除。")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 Noto Serif SC" })).toBeVisible();
  expect(
    await page.evaluate(() => document.getElementById("catalog-font-noto-serif-sc") !== null),
  ).toBe(false);
});
