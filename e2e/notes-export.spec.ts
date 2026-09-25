/**
 * Exporting highlights, in the browser.
 *
 * The formats are the desktop's, and its own tests assert the same strings: the
 * two implementations cannot share code — one is on the other side of the IPC
 * boundary, next to the *importer* that reads this CSV back — so they are pinned
 * to each other by what they write. This is the browser's half of that pin, read
 * off the downloaded file itself.
 */
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const BOOK = "public/demo/page-numbers.epub";

/** Two highlights, written straight into the store: driving a selection through
 *  the toolbar would test the toolbar, and this is about the file. */
async function seed(page: Page) {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("colorreader");
      request.addEventListener("success", () => resolve(request.result));
    });
    const books = await new Promise<{ id: string }[]>((resolve) => {
      const tx = database.transaction("books", "readonly");
      const all = tx.objectStore("books").getAll();
      all.addEventListener("success", () => resolve(all.result as { id: string }[]));
    });
    const bookId = books[0]?.id ?? "";
    const tx = database.transaction("annotations", "readwrite");
    const store = tx.objectStore("annotations");
    const base = {
      bookId,
      endChar: 2,
      cfi: null,
      createdAt: 1,
      updatedAt: 1,
    };
    store.put(
      {
        ...base,
        id: "n1",
        chapterIdx: 0,
        startChar: 0,
        text: "第一条：疾病是身体的谜题",
        note: "我的批注",
        color: "#ffd12e",
        style: null,
      },
      "n1",
    );
    store.put(
      {
        ...base,
        id: "n2",
        chapterIdx: 0,
        startChar: 1,
        text: "第二条",
        note: null,
        color: null,
        style: null,
      },
      "n2",
    );
    await new Promise((done) => tx.addEventListener("complete", () => done(undefined)));
  });
}

test("笔记导出成 Markdown 与 CSV，格式与桌面一致", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto("/");
  await page.waitForTimeout(1000);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入书籍", exact: true }).first().click();
  await (await chooser).setFiles(BOOK);
  await expect(page.getByText(/共 1 本/)).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  await seed(page);

  for (const format of ["md", "csv"] as const) {
    await page.goto("/");
    await page.waitForTimeout(1500);
    await page.getByRole("link", { name: "笔记", exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /^导出/ }).first().click({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    if (format === "csv") {
      await page.getByRole("button", { name: /CSV/ }).first().click();
      await page.waitForTimeout(400);
    }
    const download = page.waitForEvent("download", { timeout: 30_000 });
    // The button says "导出" in a browser: there is no panel to ask.
    await page
      .getByRole("button", { name: /^导出$/ })
      .last()
      .click({ timeout: 20_000 });
    const archive = await download;
    const path = await archive.path();
    expect(path, "导出应该产生一个下载").toBeTruthy();
    const body = readFileSync(path!, "utf8");
    expect(archive.suggestedFilename()).toBe(`页码样书.${format}`);
    if (format === "md") {
      // The notes page exports across books, so the page's own heading and a
      // section per book — the single-book shape is the reader pane's.
      expect(body).toContain("# 笔记导出");
      expect(body).toContain("1 本书 · 2 条标注 · 1 条有笔记");
      expect(body).toContain("## 《页码样书》");
      expect(body).toContain("> 第一条：疾病是身体的谜题");
      expect(body).toContain("我的批注");
      expect(body).toContain("?annotation=n1");
    } else {
      expect(body.startsWith("\uFEFF书名,章节,原文,笔记,颜色,样式,链接")).toBe(true);
      expect(body).toContain("#ffd12e");
      expect(body).toContain("?annotation=n1");
    }
  }
});
