import { expect, test, type Page } from "@playwright/test";

/**
 * The rail is a jump table, not a highlight.
 *
 * Every entry has to land its own group at the top of the pane. The failure
 * this pins is a rail that lit up the entry you clicked while the pane stayed
 * where it was (or moved somewhere else entirely) — which reads as the page
 * ignoring you, because the one thing that visibly changed is the pill.
 */

const SCROLLER = "[data-settings-scroll]";

/** Rail label → the group it names. */
const ENTRIES: [label: string, id: string][] = [
  ["外观", "appearance"],
  ["AI 助手", "ai"],
  ["词典", "dictionary"],
  ["字体", "fonts"],
  ["同步", "sync"],
  ["重置", "reset"],
  ["关于", "about"],
];

// The router is a memory router that always boots on the shelf, so `?demo=1`
// rides in on the first navigation and the route is reached by clicking —
// see `e2e/notes-page.spec.ts`. Settings is a chrome button rather than a rail
// link, and it is labelled 设置 in both of the places it can sit.
async function openSettings(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.waitForTimeout(600);
}

test("each rail entry shows the group it names, and stays lit on it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettings(page);

  const pane = (await page.locator(SCROLLER).boundingBox())!;
  const rail = page.locator('nav[aria-label="设置分类"]');

  for (const [label, id] of ENTRIES) {
    await page.getByRole("button", { name: label, exact: true }).click();
    // The scroll is smooth; give it somewhere to finish.
    await page.waitForTimeout(900);

    const group = (await page.locator(`[data-section="${id}"]`).boundingBox())!;
    const off = group.y - pane.y;
    // The group it names has to be fully in view. It lands 16px below the
    // pane's top — the jump aims at `offsetTop - 16` — except for the last
    // two, which the pane runs out of scroll for and stops at the bottom with.
    expect(off, `${label} → ${id}: top at ${Math.round(off)}px`).toBeGreaterThan(-8);
    expect(
      off + group.height,
      `${label} → ${id}: bottom at ${Math.round(off + group.height)}px of ${Math.round(pane.height)}`,
    ).toBeLessThan(pane.height + 8);

    // And the rail still says it is there. This is the bug: a jump used to end
    // with the highlight on the *last* group while the pane showed the one
    // that was clicked — the pane stopping at the bottom reads as "at the end"
    // to the sight-line rules, and they handed the highlight on.
    await expect(rail.locator('[aria-current="true"]'), `after ${label}`).toHaveText(label);
  }
});
