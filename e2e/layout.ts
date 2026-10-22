import type { Page } from "@playwright/test";

/**
 * Switches the reader to the 滚动 layout, the way a reader would.
 *
 * Several suites were written against the 2026-10-21 default change (scroll →
 * single page) and measure the scroller directly: `scrollTop` moves, the
 * chapter follows the wheel. They now declare the layout they mean instead of
 * inheriting a default — a test that does not say which layout it is in is
 * testing whatever the store happened to default to that week.
 *
 * The panel dance mirrors the reader-position spec's 单页 switch: open 阅读设置,
 * press the layout, close. The waits are the panel's own entrance and the
 * re-flow that follows a layout change.
 */
export async function useScrollLayout(page: Page): Promise<void> {
  // `exact` on the layout label, and `.first()` on the gear: 滚动 is a substring
  // of 自动滚动, and the settings gear sits in the header **and** the rail —
  // both would otherwise trip strict mode.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "滚动", exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
}
