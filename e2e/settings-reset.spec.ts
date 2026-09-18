import { expect, test, type Page } from "@playwright/test";

/**
 * Restoring every setting at once.
 *
 * Two things here cannot be checked from jsdom: that the reset reaches both
 * persisted stores, and that it re-snapshots the page palette rather than
 * leaving it undecided. The second is the one that bites — dropping
 * `pageTheme` back to `null` would quietly hand the reader back the setting
 * that makes foliate re-paginate the whole book on a theme switch, which is
 * the thing the snapshot exists to avoid. It is a store concern, so it is
 * pinned in `src/stores/reset.test.ts`; what this browser run adds is that the
 * control is reachable and actually does it.
 *
 * The theme radio is the probe because it is the one setting whose restored
 * value is visible without opening a book: it ships as 跟随系统, and the test
 * moves it off that first so the restore has something to undo.
 */

// The router is a memory router that always boots on the shelf, so `?demo=1`
// rides in on the first navigation and the route is reached by clicking —
// see `e2e/notes-page.spec.ts`.
async function openSettings(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  // Settings is a chrome button, not a rail link: it sits in the rail when the
  // sidebar is collapsed and inside the theme pill when it is expanded, and
  // both carry the same label.
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
}

test("restoring every setting puts the theme back, behind a confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettings(page);

  // The group is on the rail, which is where a reader looks for it.
  await page.getByRole("button", { name: "重置", exact: true }).click();

  await page.getByText("深色", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "深色" })).toBeChecked();

  await page.getByRole("button", { name: "还原", exact: true }).click();

  // Two buttons are named 还原 once the dialog is open — the row's and the
  // dialog's — so the confirming click is scoped to the dialog, as it would
  // have to be for a real reader who clicked the row by mistake.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "还原", exact: true }).click();

  await expect(page.getByText("已还原所有设置")).toBeVisible();
  await expect(page.getByRole("radio", { name: "跟随系统" })).toBeChecked();
});
