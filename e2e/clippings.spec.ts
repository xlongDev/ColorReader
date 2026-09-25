/**
 * A round trip through a clippings file, in the browser.
 *
 * Export, forget them, read the file back in. That is what a reader actually
 * does with a file like this — and it is the only test that can catch the two
 * halves drifting apart, because it reads what one wrote and checks the other
 * understood it.
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
    const base = { bookId, endChar: 2, cfi: null, createdAt: 1, updatedAt: 1 };
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

/** Empties the highlights, the way starting over would. */
async function forget(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("colorreader");
        request.addEventListener("success", () => {
          const tx = request.result.transaction("annotations", "readwrite");
          tx.objectStore("annotations").clear();
          tx.addEventListener("complete", () => resolve());
        });
      }),
  );
}

test("导出的文件能再导回来，标注与笔记都在", async ({ page }) => {
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

  // 1. Export.
  await page.getByRole("link", { name: "笔记", exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: /^导出/ }).first().click();
  await page.waitForTimeout(1200);
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page
    .getByRole("button", { name: /^导出$/ })
    .last()
    .click();
  const archive = await download;
  const path = await archive.path();
  expect(path).toBeTruthy();
  const written = readFileSync(path!, "utf8");
  expect(written).toContain("> 第一条：疾病是身体的谜题");

  // 2. Forget them.
  await forget(page);
  await page.goto("/");
  await page.waitForTimeout(1500);
  await page.getByRole("link", { name: "笔记", exact: true }).click();
  await page.waitForTimeout(2000);
  await expect(page.getByText(/0 条标注|还没有/).first()).toBeVisible({ timeout: 15_000 });

  // 3. Read the file back in.
  await page.getByRole("link", { name: "书库", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "导入摘录", exact: true }).click();
  await page.waitForTimeout(1000);
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择摘录文件" }).click();
  await (await picker).setFiles(path!);
  await page.waitForTimeout(2500);
  await expect(page.getByText("确认后会新增 2 条高亮").last()).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /^导入 \d+ 条$/ }).click();
  await page.waitForTimeout(2500);
  await expect(page.getByText("已导入 2 条高亮").last()).toBeVisible({ timeout: 20_000 });

  // The dialog is still open over the shelf; closing it is what makes the rail
  // reachable again.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await page.getByRole("link", { name: "笔记", exact: true }).click();
  await page.waitForTimeout(2500);
  const restored = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  expect(restored).toContain("第一条：疾病是身体的谜题");
  expect(restored).toContain("我的批注");
  expect(restored).toContain("第二条");
});
