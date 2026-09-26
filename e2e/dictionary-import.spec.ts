import { expect, test, type Page } from "@playwright/test";

/**
 * An MDict dictionary imported in the browser.
 *
 * 设置 → 词典 used to be desktop-only in everything but name: `dictionaryImport`
 * takes a **path**, and the list came back empty in a browser. The web build now
 * has its own entry, and with it its own copy of the MDict reader —
 * `lib/local/mdict.ts`, the browser's twin of `src-tauri/src/library/mdict.rs`.
 *
 * The fixture is the same file the Rust tests read
 * (`src-tauri/tests/fixtures/mini.mdx`, written by a third-party writer), so
 * what this pins is the half the unit tests cannot: that the reader runs in a
 * real engine, that its bytes survive IndexedDB, and that the row comes back
 * with the dictionary's own name and count. 44 entries is the fixture's, and
 * `迷你词典` is the title inside its header — not the filename, which is what
 * proves the header was parsed rather than guessed at.
 *
 * **StarDict is refused here**, and that is deliberate rather than unfinished:
 * a bundle is three files found next to each other on disk, and a file picker
 * has no directory to offer.
 */

async function openDictionaries(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "词典", exact: true }).click();
}

test("an .mdx picked in the browser is imported and listed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDictionaries(page);

  const pick = page.getByRole("button", { name: "导入词典…" });
  await expect(pick).toBeVisible();

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pick.click()]);
  await chooser.setFiles("src-tauri/tests/fixtures/mini.mdx");

  await expect(page.getByText("已导入《迷你词典》。")).toBeVisible({ timeout: 15_000 });
  // The name out of the header, the format the reader will open it with, and
  // the count out of the key section — none of which a filename would give.
  // `exact`: the group's own description also says MDict.
  await expect(page.getByText("MDict", { exact: true })).toBeVisible();
  await expect(page.getByText("44 条")).toBeVisible();
});
