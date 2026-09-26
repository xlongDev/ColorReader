import { expect, test, type Page } from "@playwright/test";

/**
 * A font imported in the browser.
 *
 * 设置 → 字体 used to be a dead end outside the desktop shell: `fontImport`
 * takes a **path**, and a browser has no paths to give — only the file itself.
 * The web build now has its own entry (`fontImportFile`), and everything past
 * it — the bytes, the store they go into, the Blob URL the `@font-face` is
 * declared from — is shared with the desktop.
 *
 * The fixture is one real subset of 霞鹜文楷 (7 kB, OFL; see
 * `THIRD-PARTY-NOTICES.md`), small enough to keep in the repo and real enough
 * that `new FontFace(...).load()` — which is the import's own validity check —
 * accepts it. A renamed `.zip` is what that check is there to reject, and the
 * point of running it in a browser is that it runs in both engines.
 */

/** 设置 is a chrome button, not a rail link; the route boots on the shelf. */
async function openFonts(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "字体", exact: true }).click();
}

test("a font picked in the browser is imported and listed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFonts(page);

  const pick = page.getByRole("button", { name: "导入字体…" });
  await expect(pick).toBeVisible();

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pick.click()]);
  await chooser.setFiles("e2e/fixtures/sample-font.woff2");

  // Named by the file, extension off — the same name the reader's font picker
  // offers it under.
  await expect(page.getByText("已导入「sample-font」。")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("sample-font", { exact: true }).first()).toBeVisible();
});
