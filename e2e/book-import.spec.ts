import { expect, test } from "@playwright/test";

/**
 * A Kindle container imported in the browser, and the shape its metadata takes.
 *
 * `?demo=1` fakes the shelf, so it cannot reach the one place a container's
 * metadata is settled: `readBook` in `lib/local/import.ts`, which is what runs
 * when a reader picks a file. foliate's readers do not agree on the shape of
 * what they hand back — EPUB answers with strings, and **a MOBI answers with
 * lists**, because foliate marks EXTH record 524 `many`. `["zh"].toLowerCase()`
 * took the whole reading page down, which is what `metadataText` exists to
 * settle; before it, the list was stored as it arrived and surfaced a page
 * later.
 *
 * The fixture carries a 524 (`scripts/generate-demo-kindle.py`). Without
 * `metadataText` the list is stored as it arrived, and the metadata sheet — the
 * first consumer that treats the field as a string — throws on `.trim()` and
 * takes the shell down with it, which is the same shape as the reading page
 * going down. So the assertion is not only the field's value: an unnormalised
 * row never gets far enough to have a value to read.
 *
 * The file is `.azw3` and the defect is a MOBI one. AZW3 and MOBI are one
 * container — one PDB shell, one record table, one parser — so the EXTH block
 * that produces the list is read by the same code either way.
 */

test("a Kindle book's list-valued language lands as one string", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  // No `?demo=1`: this is the real shelf, backed by IndexedDB, and the import
  // below writes a real row into it.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "导入书籍" }).first().click(),
  ]);
  await chooser.setFiles("public/demo/kindle-pages.azw3");

  const card = page.getByRole("button", { name: /Kindle 样书/ }).first();
  await expect(card, "导入的书要出现在书架上").toBeVisible({ timeout: 15_000 });

  await page.locator("[data-book-cover]").first().hover();
  await page.getByRole("button", { name: "编辑信息" }).first().click();

  // The container's own title, so the assertion below is about the language and
  // not about a sheet that opened on the wrong book.
  await expect(page.getByRole("textbox", { name: "书名", exact: true })).toHaveValue("Kindle 样书");
  // The defect, pinned: one string, taken from the front of the list, and the
  // shell still standing — an unnormalised row takes it down before this reads.
  await expect(page.getByRole("textbox", { name: "语言", exact: true })).toHaveValue("zh");
  await expect(page.getByText("这个界面出错了")).toHaveCount(0);
});
