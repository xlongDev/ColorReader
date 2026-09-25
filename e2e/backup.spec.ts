/**
 * The browser's backup, end to end.
 *
 * What a reader would mourn if the site data were cleared: the book, and the
 * note they made in it. The archive does not have the desktop's shape (there is
 * no browser shape of a data directory), so the only honest test is a round
 * trip: export, wipe the stores the way "clear site data" does, restore, and
 * check everything is back.
 */
import { expect, test, type Page } from "@playwright/test";

const BOOK = "public/demo/page-numbers.epub";

const state = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ books: number; annotations: number; chapters: number }>((resolve) => {
        const request = indexedDB.open("colorreader");
        request.addEventListener("success", () => {
          const tx = request.result.transaction(["books", "annotations", "chapters"], "readonly");
          const books = tx.objectStore("books").getAll();
          const annotations = tx.objectStore("annotations").getAll();
          const chapters = tx.objectStore("chapters").getAll();
          tx.addEventListener("complete", () =>
            resolve({
              books: (books.result as unknown[]).length,
              annotations: (annotations.result as unknown[]).length,
              chapters: (chapters.result as unknown[]).length,
            }),
          );
        });
      }),
  );

test("备份导出、清库、再恢复，书与笔记都回得来", async ({ page }) => {
  test.setTimeout(240_000);
  // The restore asks before it throws the library away.
  page.on("dialog", (dialog) => void dialog.accept());

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto("/");
  await page.waitForTimeout(1000);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入书籍", exact: true }).first().click();
  await (await chooser).setFiles(BOOK);
  await expect(page.getByText(/共 1 本/)).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(2000);

  // A note, written straight into the store: driving a selection through the
  // toolbar would test the toolbar, and this is about what a backup carries.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("colorreader");
      request.addEventListener("success", () => resolve(request.result));
    });
    const tx = database.transaction("annotations", "readwrite");
    tx.objectStore("annotations").put(
      {
        id: "probe-note",
        bookId: "whatever",
        chapterIdx: 0,
        text: "备份里要带上我",
        note: "一条笔记",
        color: "yellow",
        cfi: null,
        fraction: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      "probe-note",
    );
    await new Promise((done) => {
      tx.addEventListener("complete", () => done(undefined));
    });
  });

  const before = await state(page);
  expect(before.annotations, "先确认库里确实有东西可丢").toBe(1);

  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page.waitForTimeout(1500);

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "导出备份" }).click();
  const archive = await download;
  const path = await archive.path();
  expect(path, "备份应该下载下来").toBeTruthy();
  expect(archive.suggestedFilename()).toMatch(/colorreader-backup-.*\.json(\.gz)?$/);
  await expect(page.getByText(/已备份 \d+ 个文件/)).toBeVisible({ timeout: 60_000 });

  // Wipe it the way a browser's "clear site data" would. Emptying the stores
  // rather than dropping the database: `deleteDatabase` comes back `blocked`
  // while any connection is open, and the app opens several — a wipe that only
  // sometimes lands is worse than no test at all.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("colorreader");
        request.addEventListener("success", () => {
          const stores = [
            "books",
            "files",
            "chapters",
            "annotations",
            "bookmarks",
            "meta",
            "fonts",
          ];
          const tx = request.result.transaction(stores, "readwrite");
          for (const name of stores) tx.objectStore(name).clear();
          tx.addEventListener("complete", () => resolve());
        });
      }),
  );
  await page.reload();
  await page.waitForTimeout(2500);
  expect((await state(page)).books, "库应该被清空了").toBe(0);

  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page.waitForTimeout(1500);
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "从备份恢复" }).click();
  await (await picker).setFiles(path!);
  await page.waitForTimeout(6000);

  const after = await state(page);
  expect(after, "恢复后应当与备份时一模一样").toEqual(before);
});
