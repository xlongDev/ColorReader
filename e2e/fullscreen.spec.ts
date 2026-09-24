/**
 * Fullscreen in the browser build.
 *
 * The desktop mirrors the OS window; the browser has to ask the document for it
 * — and has to notice when it is taken away by something other than its own
 * button, which is what Esc and the system chrome do. Both halves are asserted
 * here, because the failure mode is silent: a button that only hides the app's
 * own chrome looks like it worked, right up until the reader notices the
 * browser is still there.
 */
import { expect, test, type Page } from "@playwright/test";

const BOOK = /我们为什么会生病/;

async function openBook(page: Page) {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: BOOK }).first().click();
  await page.waitForSelector("[data-reading-content] p", { timeout: 15_000 });
  await page.waitForTimeout(900);
}

/** Whether the *page* is fullscreen, which is the browser's own state. */
const isFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null);

test("the fullscreen button asks the browser for fullscreen, and hears when it leaves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openBook(page);

  expect(await isFullscreen(page), "进入阅读器时不该已经是全屏").toBe(false);

  await page.getByRole("button", { name: "全屏阅读" }).click();
  await page.waitForTimeout(700);
  expect(await isFullscreen(page), "按钮只收了壳，没有真的全屏").toBe(true);
  // The button reads the state it is in, so it is the visible half of the same
  // fact the assertion above just checked.
  await expect(page.getByRole("button", { name: "退出全屏" })).toBeVisible();

  // Left by the browser instead of the button — Esc does exactly this, and it
  // fires no key event the page can see.
  await page.evaluate(() => document.exitFullscreen().catch(() => {}));
  await page.waitForTimeout(700);
  expect(await isFullscreen(page), "浏览器退出全屏后没有同步").toBe(false);
  await expect(page.getByRole("button", { name: "全屏阅读" })).toBeVisible();

  // And the button can leave it too, not just enter. The header hides itself
  // after a few seconds of stillness — the reader's own rule, not a bug — so it
  // is woken the way a reader would wake it: by moving the pointer.
  await page.mouse.move(640, 400);
  await page.mouse.move(640, 20);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "全屏阅读" }).click();
  await page.waitForTimeout(700);
  expect(await isFullscreen(page)).toBe(true);
  await page.mouse.move(640, 400);
  await page.mouse.move(640, 20);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "退出全屏" }).click();
  await page.waitForTimeout(700);
  expect(await isFullscreen(page), "退出全屏按钮没有真的退出").toBe(false);
});
