import { expect, test, type Page } from "@playwright/test";

/**
 * The image browser, in the browser build.
 *
 * Nothing had ever opened it. The desktop answers `book_images` out of the
 * chapter text it already stores, and the browser collects the same list during
 * import — but the viewer's *position* was computed against a different list
 * from the one it rendered, so a click on the third picture opened the first
 * and the arrows never followed the picture that was clicked. A row written
 * before the list was collected had none at all, and listed only what had been
 * clicked since.
 *
 * The fixture is `e2e/fixtures/images.epub` (see
 * `scripts/generate-images-fixture.py`): three pictures in the first chapter, of
 * different sizes, so "the one I clicked" and "the first one" are different
 * answers. What the viewer is showing is read off the 保存图片 link's
 * `download`, which is the picture's own filename — an identity, not a count
 * that could agree with a broken index by accident.
 */

/** The third picture is the one worth clicking: index 0 of the wrong list is
 *  also index 0 of the right one. */
const THIRD = 2;

/** One picture of the open book, in reading order, inside foliate's iframe. */
async function bookImage(page: Page, position: number) {
  await expect
    .poll(
      async () =>
        (
          await Promise.all(page.frames().map((frame) => frame.locator("img[data-path]").count()))
        ).reduce((sum, count) => sum + count, 0),
      { timeout: 15_000, message: "样书的图片没有渲染出来" },
    )
    .toBeGreaterThanOrEqual(3);

  const view = page.viewportSize()!;
  for (const frame of page.frames()) {
    const images = frame.locator("img[data-path]");
    if ((await images.count()) <= position) continue;
    const image = images.nth(position);
    // Wait for the picture to be one the reader could actually click: laid out
    // (the handler ignores anything under 48px) and inside the pane. A section
    // is in the DOM before the paginator has placed it, and a picture in a
    // column the paginator has moved past is one `.click()` cannot reach — it
    // scrolls a container foliate moves by transform, so the click lands on
    // nothing and the spec fails for a reason that is not what it checks.
    await expect
      .poll(
        async () => {
          const box = await image.boundingBox();
          if (!box || box.width < 48 || box.height < 48) return false;
          return (
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= view.width &&
            box.y + box.height <= view.height
          );
        },
        { message: `第 ${position + 1} 张图不在可点的位置` },
      )
      .toBe(true);
    return image;
  }
  throw new Error(`第 ${position + 1} 张图不在任何 section 里`);
}

/** What the lightbox says it is showing: the picture's own filename. */
const shown = (page: Page) => page.getByRole("link", { name: /保存图片/ });

/** Imports the fixture onto an empty shelf. */
async function importBook(page: Page): Promise<void> {
  await page.goto("/");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "导入书籍" }).first().click(),
  ]);
  await chooser.setFiles("e2e/fixtures/images.epub");
  await expect(page.getByRole("button", { name: /图片样书/ }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function openBook(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /图片样书/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Drops `images` from every book row — the shape a row written before the list
 * was collected has. The store is touched directly because no import produces
 * such a row any more, and the point is that a reader who has one is not told
 * to import their library again.
 *
 * The connection is opened *after* the shelf has rendered, never before: a
 * second connection racing the app's own versioned open is a way to hang the
 * page rather than to read it.
 */
async function forgetImageLists(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settled = <T>(input: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        input.addEventListener("success", () => resolve(input.result));
        input.addEventListener("error", () => reject(input.error));
      });

    const database = await settled(indexedDB.open("colorreader"));
    const store = database.transaction("books", "readwrite").objectStore("books");
    const rows = (await settled(store.getAll())) as Record<string, unknown>[];
    for (const row of rows) {
      delete row.images;
      store.put(row, row.id as string);
    }
    // A write is settled by the transaction, not by its requests — the same
    // rule `lib/local/db.ts` learned the hard way.
    await new Promise<void>((resolve, reject) => {
      store.transaction.addEventListener("complete", () => resolve());
      store.transaction.addEventListener("error", () => reject(store.transaction.error));
    });
    database.close();
  });
}

/** The stored picture list of the one book on the shelf, or `null` for none. */
async function storedImages(page: Page): Promise<{ path: string }[] | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("colorreader");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const rows = (await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const all = database.transaction("books", "readonly").objectStore("books").getAll();
      all.addEventListener("success", () => resolve(all.result as Record<string, unknown>[]));
      all.addEventListener("error", () => reject(all.error));
    })) as Record<string, unknown>[];
    database.close();
    return (rows[0]?.images as { path: string }[] | undefined) ?? null;
  });
}

test("clicking a picture opens the viewer on that picture, and the arrows walk the book", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await importBook(page);
  await openBook(page);

  await (await bookImage(page, THIRD)).click();

  await expect(shown(page), "点开的是第三张，就该是第三张").toHaveAttribute("download", "fig3.png");
  await expect(page.getByText("3 / 3", { exact: true }).first()).toBeVisible();

  // And the book's own order is what the arrows walk: back one lands on fig2.
  await page.getByRole("button", { name: "上一张" }).click();
  await expect(shown(page)).toHaveAttribute("download", "fig2.png");
  await expect(page.getByText("2 / 3", { exact: true }).first()).toBeVisible();
});

test("a book whose list predates the field gets one, without being imported again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await importBook(page);

  // Age the row into the shape this is about, before the reader ever asks for
  // the list — which is the state an existing library is in.
  await forgetImageLists(page);
  expect(await storedImages(page), "删掉之后应当真的没有清单").toBeNull();

  await openBook(page);

  // Opening the book asks for the list, and a row without one is rebuilt from
  // the book's own bytes and kept. The assertion is on what got stored rather
  // than on the viewer: the viewer's own behaviour is the first test's job, and
  // reaching a picture inside foliate's iframe is a way to test the click
  // twice and this once.
  await expect
    .poll(async () => (await storedImages(page))?.map((image) => image.path), {
      timeout: 15_000,
      message: "打开书之后清单没有回填",
    })
    .toEqual(["OEBPS/images/fig1.png", "OEBPS/images/fig2.png", "OEBPS/images/fig3.png"]);
});
