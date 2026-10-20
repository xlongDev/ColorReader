import { expect, test } from "@playwright/test";

/**
 * 对照阅读: two books, one window.
 *
 * The whole wiring only exists across a route change and a store round trip —
 * which book opens beside which, that the pair survives a trip to the shelf,
 * and that closing it leaves one reader — so this lives here rather than in
 * the unit suite. `?demo=1` supplies the fixture books (see
 * `e2e/notes-page.spec.ts` for why it rides in on the boot navigation), and
 * `&epub=1` adds the one multi-chapter book on that shelf, which is what the
 * keyboard test needs.
 *
 * The demo shelf ignores the search box (the fixture answers every query the
 * same way), so books are pinned by title rather than by filtering.
 */

const VIEWPORT = { width: 1280, height: 800 };

/** The fixture EPUB: the demo shelf's only multi-chapter book. */
const EPUB_COVER = 'button:has([data-book-cover]):has-text("页码样书")';

test("对照阅读 puts a second book beside the first, and the pair is remembered", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    // webkit reports the split view's paired ResizeObservers as an uncaught
    // "loop completed with undelivered notifications" error — the browser's
    // own depth guard, not the app's: nothing is lost, and the assertion
    // below stays meaningful for everything else.
    if (/ResizeObserver loop/.test(error.message)) return;
    pageErrors.push(error.message);
  });

  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1&epub=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.locator(EPUB_COVER).click();

  // The reader is open, and its header carries the way in.
  await expect(page.locator("[data-reader-title]")).toHaveText("页码样书");
  await page.getByRole("button", { name: "对照阅读" }).click();

  // The picker names the book it would open beside this one, and never this
  // one itself.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /页码样书/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: /金色梦乡/ }).click();

  // Two panes, both reading, under one bar above and one bar below. The top
  // bar names both books at once — one block each, no switching — and the
  // controls live in the bar at the bottom.
  await expect(page.locator("[data-pair-pane]")).toHaveCount(2);
  await expect(page.locator("[data-pair-pane] [data-reading-viewport]")).toHaveCount(2);
  const blocks = page.locator("[data-pair-block]");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0).locator("[data-reader-title]")).toHaveText("页码样书");
  await expect(blocks.nth(1).locator("[data-reader-title]")).toHaveText("金色梦乡");
  await expect(page.getByRole("button", { name: "更换对照书" })).toBeVisible();

  // The shared bottom bar holds the footer on one row: the full set measures
  // ~1109px and `flex-wrap` turns it into a three-line pile otherwise. The row
  // is probed by vertical centre — the progress readout is text-height while
  // the controls are 32px, so a raw `offsetTop` differs by design on one line.
  const footerRows = await page.locator("[data-pair-bottom] footer > *").evaluateAll((nodes) => {
    const centres = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    return Math.max(...centres) - Math.min(...centres);
  });
  expect(footerRows, "the pair's footer must be a single row").toBeLessThan(4);

  // The pair is a relationship between books, not a mode one of them is in:
  // back to the shelf, open the same book, and the companion is there again.
  await page.getByRole("button", { name: "返回书库" }).click();
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.locator(EPUB_COVER).click();
  await expect(page.locator("[data-pair-pane]")).toHaveCount(2);

  // Closing the pair leaves one reader, and the header offers the way back in.
  // The exit handle rides the seam and only appears while the pointer is near
  // it, so the hover is part of using it — not a test convenience.
  await page.locator("[data-pair-divider]").hover();
  await page.getByRole("button", { name: "退出对照" }).click();
  await expect(page.locator("[data-pair-pane]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "对照阅读" })).toBeVisible();

  expect(pageErrors, "page errors must stay empty").toEqual([]);
});

/**
 * The keyboard belongs to the pane the reader is working in.
 *
 * Two mounted readers would otherwise both turn a page per keypress. The
 * failure this pins is the gate, not the paging: with the companion active,
 * a page key must move the companion and leave the primary where it was.
 */
test("对照阅读 hands the keyboard to the pane that was clicked", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1&epub=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.locator(EPUB_COVER).click();
  await expect(page.locator("[data-reader-title]")).toHaveText("页码样书");

  await page.getByRole("button", { name: "对照阅读" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /金色梦乡/ })
    .click();
  await expect(page.locator("[data-pair-pane]")).toHaveCount(2);

  const primary = page.locator("[data-pair-pane]").first();
  const companion = page.locator("[data-pair-pane]").nth(1);
  // The book just opened is the active pane.
  await expect(primary).toHaveAttribute("data-pair-active", "true");

  // Both books are named at once — one block each in the bar above them, in
  // the order of the panes below. Each block's readout is its own book's, so
  // this test can always tell which reader moved.
  const blocks = page.locator("[data-pair-block]");
  const primaryBlock = blocks.nth(0);
  const companionBlock = blocks.nth(1);
  const primaryChapter = primaryBlock.locator("[data-reader-chapter]");
  const companionChapter = companionBlock.locator("[data-reader-chapter]");
  await expect(primaryChapter).toContainText("第 1 /");

  // A page key turns the active pane. The press is retried inside the poll
  // because foliate's own opening position lands asynchronously — a press that
  // beats it is undone by it, and that looks exactly like a dead key. The gate
  // under test is *which pane moves*, and a press loop cannot fake that.
  await expect
    .poll(
      async () => {
        await page.keyboard.press("ArrowRight");
        const text = await primaryChapter.textContent();
        return /第 (\d+) \//.exec(text ?? "")?.[1] ?? "1";
      },
      { timeout: 10_000, intervals: [400] },
    )
    .toMatch(/^[2-4]$/);

  // The poll's last press can still be landing — foliate loads a section
  // asynchronously, and the readout moves when that load lands, so a sample
  // taken mid-flight would blame the gate for the catch-up. Sample once the
  // readout holds still across two reads.
  let before = await primaryChapter.textContent();
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(300);
        const now = await primaryChapter.textContent();
        const settled = now === before;
        before = now;
        return settled;
      },
      { timeout: 5000, intervals: [300] },
    )
    .toBe(true);

  // The other book's steppers turn *it*, without handing it the keyboard: the
  // whole point of giving each book its own arrows in one shared bar.
  const companionBefore = await companionChapter.textContent();
  await companionBlock.getByRole("button", { name: "下一章" }).click();
  await expect(companionChapter).not.toHaveText(companionBefore ?? "");
  await expect(companionBlock).not.toHaveAttribute("data-pair-active", "true");
  await expect(primary).toHaveAttribute("data-pair-active", "true");

  // Hand the window to the companion by clicking the block that names it.
  await companionBlock.locator('button[title^="切换到"]').click();
  await expect(companion).toHaveAttribute("data-pair-active", "true");

  // Now the keyboard turns the companion and the primary's readout is frozen.
  const frozen = await primaryChapter.textContent();
  const companionNow = await companionChapter.textContent();
  await expect
    .poll(
      async () => {
        await page.keyboard.press("ArrowRight");
        return companionChapter.textContent();
      },
      { timeout: 10_000, intervals: [400] },
    )
    .not.toBe(companionNow);
  expect(await primaryChapter.textContent()).toBe(frozen);

  // And clicking a pane's paper hands it back — the pointer path, which the
  // block must not be the only way to take. The book's text lives in a
  // foliate iframe, so this is the one click path the pane cannot hear itself
  // (see `PairPane`); it has to arrive through the section document.
  await primary.locator("[data-reading-viewport]").click({ position: { x: 12, y: 12 } });
  await expect(primary).toHaveAttribute("data-pair-active", "true");
  const frozenIndex = /第 (\d+) \//.exec(frozen ?? "")?.[1];
  await expect(primaryChapter).toContainText(`第 ${frozenIndex} /`);
});

/**
 * A pair's chrome acts on the book that owns it.
 *
 * Three things used to disagree here. The drawer found its host by "first
 * reading viewport in the document", which is always the left book's, so a
 * panel opened from the right book appeared over the left one. The 简繁 menu
 * opened downward from a button that now sits in the bottom bar, so its
 * options fell off the window. And the only way out of a pair was an ✕ on the
 * seam that stays invisible until the pointer finds the middle of a 1px line.
 */
test("对照阅读 keeps a panel in the book that opened it, and the picker closes the pair", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1&epub=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.locator(EPUB_COVER).click();
  await expect(page.locator("[data-reader-title]")).toHaveText("页码样书");
  await page.getByRole("button", { name: "对照阅读" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /金色梦乡/ })
    .click();
  await expect(page.locator("[data-pair-pane]")).toHaveCount(2);

  const companion = page.locator("[data-pair-pane]").nth(1);
  await companion.locator("[data-reading-viewport]").click({ position: { x: 24, y: 24 } });
  await expect(companion).toHaveAttribute("data-pair-active", "true");

  // 简繁转换 lives in the bottom bar in a pair: its menu has to open upward,
  // or every option is below the window's edge.
  await page.getByRole("button", { name: "简繁转换" }).click();
  const menu = page.getByRole("menu", { name: "简繁转换" });
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  const zhButtonBox = await page.getByRole("button", { name: "简繁转换" }).boundingBox();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(zhButtonBox!.y + 1);
  await page.keyboard.press("Escape");

  // Every panel opens in the selected book's half, not in the left one. The
  // drawer is portaled into a reading viewport, so its box tells which.
  const paneBox = await companion.boundingBox();
  for (const name of ["目录与书签", "搜索", "标注", "知识图谱", "AI 导读", "阅读设置"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const drawer = page.locator("[data-reading-viewport] aside").first();
    await expect(drawer).toBeVisible();
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox!.x, `${name} must open in the selected book`).toBeGreaterThanOrEqual(
      paneBox!.x - 1,
    );
    expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1);
    // Toggle it shut from the same button: deterministic, unlike Escape, which
    // a panel with a focused input may swallow.
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("[data-reading-viewport] aside")).toHaveCount(0);
  }

  // A panel belongs to the book being read: handing the window to the other
  // book closes it. Left open, the drawer kept dimming a page nobody was
  // working on, and the bar's buttons — which now drive the other book —
  // could not close it; that leftover is what read as "the panel opened in
  // the wrong book".
  await page.getByRole("button", { name: "目录与书签", exact: true }).click();
  await expect(page.locator("[data-reading-viewport] aside")).toHaveCount(1);
  await page
    .locator("[data-pair-pane]")
    .nth(0)
    .locator("[data-reading-viewport]")
    .click({ position: { x: 24, y: 24 } });
  await expect(page.locator("[data-pair-pane]").nth(0)).toHaveAttribute("data-pair-active", "true");
  await expect(page.locator("[data-reading-viewport] aside")).toHaveCount(0);

  // And the picker carries the way out, for anyone who never finds the seam.
  await page.getByRole("button", { name: "更换对照书" }).click();
  await page.getByRole("button", { name: "退出对照阅读" }).click();
  await expect(page.locator("[data-pair-pane]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "对照阅读" })).toBeVisible();
});

/**
 * The reading ruler is a reading aid for the page being read, not a property
 * of the window: a pair shows it in the book the reader is working in, and
 * switching books moves it.
 */
test("对照阅读 shows the reading ruler only in the book being read", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1&epub=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.locator(EPUB_COVER).click();
  await expect(page.locator("[data-reader-title]")).toHaveText("页码样书");
  await page.getByRole("button", { name: "对照阅读" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /金色梦乡/ })
    .click();
  await expect(page.locator("[data-pair-pane]")).toHaveCount(2);

  const panes = page.locator("[data-pair-pane]");
  await page.getByRole("button", { name: "开启阅读标尺" }).click();
  await expect(panes.nth(0).locator("[data-reading-ruler]")).toHaveCount(1);
  await expect(panes.nth(1).locator("[data-reading-ruler]")).toHaveCount(0);

  // The other book takes the ruler when it takes the window.
  await panes
    .nth(1)
    .locator("[data-reading-viewport]")
    .click({ position: { x: 24, y: 24 } });
  await expect(panes.nth(1)).toHaveAttribute("data-pair-active", "true");
  await expect(panes.nth(1).locator("[data-reading-ruler]")).toHaveCount(1);
  await expect(panes.nth(0).locator("[data-reading-ruler]")).toHaveCount(0);
});
