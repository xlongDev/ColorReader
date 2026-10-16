import { expect, test, type Page } from "@playwright/test";

/**
 * 正文加粗 — the body text in the bold weight.
 *
 * Two claims about this setting are structural, and neither is visible to a
 * unit test, which is why it has a spec of its own:
 *
 * 1. It has to reach **two different renderers**. A foliate book is set by a
 *    stylesheet injected into each section document; a plain-text book is
 *    composed here, as an inline style on the flow. The two share nothing but
 *    the setting, and a change that lands in one and not the other is the
 *    shape of the bug this file exists to catch.
 * 2. It must survive **使用书籍排版**, which is on by default (跟随书籍). Every
 *    other typography setting stands down under that gate; this one is an
 *    accessibility override and must not. Since the default *is* 跟随书籍,
 *    every case below runs under it — the independence is asserted by the
 *    fixture's own starting state rather than by a step that could be
 *    forgotten.
 *
 * What is read is the **computed** weight, not the rendered pixels. The
 * computed value of `bold` is 700 whatever face ends up painting — a real
 * bold face on a family that has one, a synthesised one on a family that does
 * not — so the assertion is about our CSS and not about which font the
 * machine happens to own. (Measured 2026-10-16: a single-face family renders
 * two distinct weights, and 600 is where synthesis starts.)
 */

/** Opens a sample book and settles on the reader's first page. */
async function openReader(page: Page, { query, title }: { query: string; title: RegExp }) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(query);
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(800);
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
}

/** One group of the settings drawer, by its label. Assumes the drawer is open. */
const group = (page: Page, label: string) =>
  page
    .locator("aside div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .last();

/** The weight the first paragraph of the book's own section is set in. */
const sectionWeight = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const frames = view?.shadowRoot
      ?.querySelector("foliate-paginator")
      ?.shadowRoot?.querySelectorAll("iframe");
    for (const frame of frames ?? []) {
      const doc = frame.contentDocument;
      if (!doc?.body?.textContent?.trim()) continue;
      const p = doc.querySelector("p");
      if (p) return getComputedStyle(p).fontWeight;
    }
    return "";
  });

/** The same question on the prose path, which composes the page in this document. */
const proseWeight = (page: Page) =>
  page.evaluate(() => {
    const p = document.querySelector(".prose-reader p");
    return p ? getComputedStyle(p).fontWeight : "";
  });

/** Flips the switch in the panel and leaves the drawer open. */
async function pick(page: Page, label: "常规" | "加粗") {
  await group(page, "正文加粗").getByRole("button", { name: label, exact: true }).click();
}

test.describe("正文加粗", () => {
  test("EPUB：加粗落进 section 文档，关掉还原成书自己的字重", async ({ page }) => {
    await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });

    const before = await sectionWeight(page);
    expect(before, "section 里没读到段落").not.toBe("");
    // The fixture sets its chapters in plain <p>s, so this is the weight the
    // book asked for — the value the toggle has to give back.
    expect(before).toBe("400");

    await openSettings(page);
    await pick(page, "加粗");
    // A foliate style change re-injects the sheet into every loaded section and
    // expands it, so the repaint is a beat after the click.
    await expect.poll(() => sectionWeight(page), { timeout: 10_000 }).toBe("700");

    await pick(page, "常规");
    await expect.poll(() => sectionWeight(page), { timeout: 10_000 }).toBe(before);
  });

  test("纯文本：同一条设置走 prose 通路，关掉还原", async ({ page }) => {
    await openReader(page, { query: "/?demo=1", title: /我们为什么会生病/ });

    const before = await proseWeight(page);
    expect(before, "prose 里没读到段落").not.toBe("");
    expect(before).toBe("400");

    await openSettings(page);
    await pick(page, "加粗");
    await expect.poll(() => proseWeight(page), { timeout: 10_000 }).toBe("700");

    await pick(page, "常规");
    await expect.poll(() => proseWeight(page), { timeout: 10_000 }).toBe(before);
  });

  test("PDF 上不给这个开关：文字是画出来的，没有字重可改", async ({ page }) => {
    await openReader(page, { query: "/?demo=1&pdf=1", title: /PDF 样书/ });

    await openSettings(page);
    // The group the reader *can* see on a book, so the count below is about
    // this one setting and not about the drawer having failed to open.
    await expect(group(page, "书籍排版")).toBeVisible();
    await expect(page.getByText("正文加粗", { exact: true })).toHaveCount(0);
  });
});
