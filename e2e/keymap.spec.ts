import { expect, test, type Page } from "@playwright/test";

/**
 * Rebinding a key, from the panel to the press.
 *
 * Two links in this chain are invisible to a unit test, and both are the kind
 * that fail silently:
 *
 * 1. **The recorder has to take the press it is given.** It listens on `window`
 *    in the *capture* phase and stops what it hears, because the key the reader
 *    presses to rebind something may itself be a command — ⌘K opens the palette
 *    — and a recorder that let that through would open a dialog on top of the
 *    panel and then record the press that opened it.
 * 2. **The write has to reach the dispatcher that reads it.** The reader
 *    resolves its own keys from the settings store on every press
 *    (`features/reader/readerKeys.ts`), and nothing but a real browser can show
 *    that a binding written by the panel is the binding the reader answers to.
 *
 * So each test below walks the whole path, and the one that matters reloads the
 * app in between: a fresh load reads the stored binding, which is the only
 * honest way to tell a setting from a panel's own state.
 *
 * `?demo=1` supplies the sample book, which opens in the 滚动 layout — the one
 * where ArrowRight steps a chapter rather than turning a page, so 「下一章」 is
 * the binding under test there.
 */

const BOOK = /我们为什么会生病/;

/** Settings → 快捷键, with the section's rows on screen. */
async function openKeymap(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  // Settings is a chrome button rather than a rail link, and it is labelled
  // 设置 in both of the places it can sit — see `e2e/settings-rail.spec.ts`.
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "快捷键", exact: true }).click();
  await page.waitForTimeout(600);
}

/**
 * One row of the keymap.
 *
 * Found by the button that rebinds it rather than by a test hook of its own:
 * every row carries `aria-label="修改 <动作> 的按键"`, which is what the reader
 * hears from a screen reader anyway — so the selector cannot drift away from
 * what the row means.
 */
function row(page: Page, title: string) {
  return page
    .locator('[data-section="keys"]')
    .getByRole("button", { name: `修改 ${title} 的按键` })
    .locator("..");
}

/** The keys a row is showing, as the keycaps print them. */
async function badges(page: Page, title: string): Promise<string[]> {
  return row(page, title).locator("kbd").allInnerTexts();
}

/** Clicks 改键 on a row and sends one press at it. */
async function rebind(page: Page, title: string, key: string): Promise<void> {
  await row(page, title)
    .getByRole("button", { name: `修改 ${title} 的按键` })
    .click();
  await expect(page.getByText("按下新键…")).toBeVisible();
  await page.keyboard.press(key);
  await page.waitForTimeout(200);
}

/** The whole-book progress the reader's footer prints. */
async function progress(page: Page): Promise<number> {
  const text = await page.locator("[data-reader-progress]").first().innerText();
  return Number(text.replace("%", "").trim());
}

/** Opens the sample book and settles on its first page. */
async function openBook(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: BOOK }).first().click();
  await page.waitForSelector("[data-reading-content]", { timeout: 15_000 });
  await page.waitForTimeout(900);
}

test("the recorder takes the press it is given, not the one that would run a command", async ({
  page,
}) => {
  await openKeymap(page);
  expect(await badges(page, "向右翻页"), "翻页键的默认值").toEqual(["→"]);

  // ⌘K (Ctrl+K on the runner) opens the command palette, and the palette is a
  // *global* hotkey — the same stream `useHotkeys` listens on. The recorder is
  // in the capture phase precisely so this press never reaches it.
  await rebind(page, "向右翻页", "Control+k");

  await expect(page.getByRole("dialog"), "记录时不许弹出命令面板").toHaveCount(0);
  expect(await badges(page, "向右翻页"), "记下来的是刚按的那一下").toEqual(["⌘ K"]);
  // And the row now offers to put it back, which is the panel saying it knows
  // this is not the default.
  await expect(
    row(page, "向右翻页").getByRole("button", { name: "恢复 向右翻页 的默认按键" }),
  ).toBeVisible();
});

test("Escape leaves the recorder without binding anything", async ({ page }) => {
  await openKeymap(page);
  await row(page, "向右翻页").getByRole("button", { name: "修改 向右翻页 的按键" }).click();
  await expect(page.getByText("按下新键…")).toBeVisible();

  // Escape is the way out, so it cannot also be a binding — a key the reader
  // could not cancel out of would be worse than one they cannot make.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  await expect(page.getByText("按下新键…")).toHaveCount(0);
  expect(await badges(page, "向右翻页"), "取消之后还是原来的键").toEqual(["→"]);
});

test("the reader answers to the key the panel wrote", async ({ page }) => {
  await openKeymap(page);
  await rebind(page, "下一章", "n");
  // The recorded key is what the press reported (`n`); the badge prints it the
  // way a keycap does (`N`).
  expect(await badges(page, "下一章")).toEqual(["N"]);

  // A reload in between: what is being tested is the stored binding, not the
  // panel's own state.
  await openBook(page);

  const before = await progress(page);
  // The key it used to answer to is nobody's now.
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(700);
  expect(await progress(page), "ArrowRight 已经交出去了").toBe(before);

  await page.keyboard.press("n");
  await page.waitForTimeout(700);
  expect(await progress(page), "改后的键必须换章").toBeGreaterThan(before);
});

test("a rebind that takes a key away from something else is reported", async ({ page }) => {
  await openKeymap(page);
  // ArrowRight is 下一章's key in the 滚动 layout, so handing it to 上一章 as
  // well leaves 上一章 with nothing it can win — the reader would press it and
  // watch nothing happen.
  await rebind(page, "上一章", "ArrowRight");

  const section = page.locator('[data-section="keys"]');
  await expect(section.getByText("需要注意")).toBeVisible();
  await expect(section, "点名的必须是按不到的那一条").toContainText("「上一章」按不到了");
  await expect(section).toContainText("「下一章」");
});

test("全部恢复默认 puts every key back", async ({ page }) => {
  await openKeymap(page);
  await rebind(page, "向右翻页", "n");
  await rebind(page, "下一章", "m");

  await page.getByRole("button", { name: "全部恢复默认" }).click();
  await page.waitForTimeout(200);

  // Every reset button is gone, because nothing is on an override any more.
  await expect(
    page.locator('[data-section="keys"]').getByRole("button", { name: /恢复 .+ 的默认按键/ }),
  ).toHaveCount(0);
  expect(await badges(page, "向右翻页")).toEqual(["→"]);
  expect(await badges(page, "下一章")).toEqual(["→"]);
});
