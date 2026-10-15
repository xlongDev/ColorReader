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
 * rules, and this one is about the journey — install, offer, select, remove,
 * survive a restart offline, go away with 重置.
 *
 * Noto Serif SC has no other way into the app at all: nothing ships a font, so
 * if the reader renders this family the catalogue put it there.
 *
 * The subset `woff2` files are not shipped as fixtures and are aborted: the
 * glyph stream is the browser's job, and what this pins is the app's own
 * contract — the sheet is installed, the face is offered, the picker selects
 * it, and the engine parses the family into `document.fonts`.
 */

const FIXTURES = "e2e/fixtures/font-catalog";

/** The two hosts the manifest lists, both serving the pinned sheets. */
async function routeSheets(page: Page): Promise<void> {
  await page.route("**/noto-serif-sc@5.3.1/*.css", (route) => {
    const weight = route.request().url().endsWith("/700.css") ? "700" : "400";
    void route.fulfill({
      path: `${FIXTURES}/noto-serif-sc-${weight}.css`,
      contentType: "text/css",
    });
  });
  await page.route("**/files/noto-serif-sc-*.woff2", (route) => route.abort());
}

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
  await routeSheets(page);

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

/**
 * 断网之后，装过的字体还在。
 *
 * The claim under test is narrow on purpose, because the wider one is false:
 * what the app keeps locally is the `@font-face` **sheet**. The glyph subsets
 * are still the browser's to fetch and cache, so this asserts that the family
 * is in the document after a reload with every CDN request refused — which is
 * the sheet coming out of storage, since a sheet that had to be fetched would
 * have failed and left the reader on the fallback family.
 *
 * Nothing adopts the sheets at boot: they come back the way they went in, on
 * the reader path, when a book asks for the family. So the reload has to land
 * in the book rather than on the shelf.
 */
test("an installed font is still there after a reload with the CDN gone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await routeSheets(page);

  await openFonts(page);
  await page.getByRole("button", { name: "下载 Noto Serif SC" }).click();
  await expect(page.getByRole("button", { name: "删除 Noto Serif SC" })).toBeVisible({
    timeout: 15_000,
  });

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

  // The network goes away for good, the sheets included.
  await page.unroute("**/noto-serif-sc@5.3.1/*.css");
  await page.route("**/noto-serif-sc@5.3.1/*.css", (route) => route.abort());
  // Scoped to the CDN, and to stylesheets: the app's own `index-*.css` comes
  // back on the reload too, and counting it would make this assertion about
  // nothing.
  const sheetRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.endsWith(".css") && /jsdelivr|unpkg/.test(url)) sheetRequests.push(url);
  });

  await page.reload();
  // The router always boots on the shelf, so the book is opened again; the
  // reader comes back on the family that was picked, from the settings store.
  await page
    .getByRole("button", { name: /我们为什么会生病/ })
    .first()
    .click();

  // The family is in the document, which it can only be from the kept sheet:
  // the route above refuses every attempt to fetch one, and a sheet that had
  // to be fetched would have left the reader on the fallback family.
  await expect.poll(() => parsedFamilies(page), { timeout: 10_000 }).toContain("Noto Serif SC");
  expect(sheetRequests).toEqual([]);
});

/**
 * 归档类条目在浏览器端只说明怎么拿到，不给一个点了必然失败的按钮。
 *
 * HarmonyOS Sans 是目录里唯一一个「从厂商整包里取成员」的条目，而取成员需要 zip
 * 读取器和文件系统 —— 浏览器两样都没有。这一条钉的是那份诚实：行还在、许可
 * 声明还在（协议第 2.1 条要求软件里写明用了这套字体，而这行是应用里唯一的
 * 落点），但按钮换成了指向「导入字体」的说明。渲染一个按钮、让它从 IPC 层里
 * 抛出「找不到某个全局量」，读起来是应用坏了，而不是「这条路浏览器走不了」。
 */
test("the archive entry explains itself instead of offering a button the web build cannot honour", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFonts(page);

  // Both shown while the font is *not* installed, which is when the reader is
  // deciding — a notice that only appeared after installing would be no notice.
  await expect(page.getByText("HarmonyOS Sans", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/本软件使用了 HarmonyOS Sans 字体/)).toBeVisible();
  await expect(page.getByText(/从官方整包中只下载需要的成员/)).toBeVisible();

  // The group's own description is the *second* place this claim lives, and the
  // first cut of the range-route change updated only the row — so the page went
  // on telling the reader to download the whole package while the row directly
  // beneath it said 5.4 MB. Pin both: the stale sentence has to be gone, and the
  // description has to make the same promise the row makes.
  await expect(page.getByText(/要下载厂商官方整包/)).toHaveCount(0);
  await expect(page.getByText(/只从厂商的官方整包里取需要的那个字体文件/)).toBeVisible();

  await expect(page.getByRole("button", { name: "下载 HarmonyOS Sans" })).toHaveCount(0);
  await expect(page.getByText("浏览器端请自行下载后用「导入字体」")).toBeVisible();

  // Not a dead end: the import button below takes the face once the reader has
  // fetched the archive themselves.
  await expect(page.getByRole("button", { name: /导入字体/ })).toBeVisible();
});

/**
 * 重置 把目录字体一起卸掉。
 *
 * `downloadedFonts` is a preference and goes with the rest of them; the sheet
 * in the document is not, and it is the half that used to be left behind —
 * 霞鹜文楷 stayed declared and rendering with no row anywhere saying it was
 * installed, and no way for the reader to take it out short of a reinstall.
 */
test("restoring every setting uninstalls a catalogue font with the rest", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await routeSheets(page);

  await openFonts(page);
  await page.getByRole("button", { name: "下载 Noto Serif SC" }).click();
  await expect(page.getByRole("button", { name: "删除 Noto Serif SC" })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "重置", exact: true }).click();
  await page.getByRole("button", { name: "还原", exact: true }).click();
  // Two buttons are named 还原 once the dialog is open — see
  // `settings-reset.spec.ts`.
  await page.getByRole("dialog").getByRole("button", { name: "还原", exact: true }).click();
  await expect(page.getByText("已还原所有设置")).toBeVisible();

  await page.getByRole("button", { name: "字体", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载 Noto Serif SC" })).toBeVisible();
  expect(
    await page.evaluate(() => document.getElementById("catalog-font-noto-serif-sc") !== null),
  ).toBe(false);
});
