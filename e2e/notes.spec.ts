/**
 * Notes page — a view over the highlights made *in books*.
 *
 * The app uses a memory router (`createMemoryRouter`), so `page.goto` and
 * `page.url()` reflect the document, not the route. Navigation has to come
 * from inside the app — click the sidebar link — and assertions target visible
 * state rather than `toHaveURL`, which would check the wrong URL.
 *
 * `?demo=1` carries sample highlights for two of the three sample books (see
 * `lib/demo.ts`), which is the only way the page has anything to aggregate
 * outside the Tauri shell. demo-1 has three highlights (two with notes) and
 * demo-2 has two (one with a note); demo-3 has none and must not appear.
 *
 * The *order* of the two groups is not asserted: the page groups in the
 * shelf's sort order, and in the browser the shelf is the fixture array
 * unsorted, because the sorting lives in the backend that `?demo=1` stands in
 * for. Pinning the order here would pin a fixture artefact.
 */
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  await context.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      // Storage may be denied in some sandboxes; the test still runs.
    }
  });
});

async function openNotes(page: Page) {
  await page.goto("/?demo=1");
  await page.getByRole("link", { name: "笔记" }).click();
  await expect(page.getByRole("heading", { name: "笔记", level: 1 })).toBeVisible();
}

/** The row whose passage contains `text`. */
function row(page: Page, text: string) {
  return page.locator("li").filter({ hasText: text });
}

test("the page aggregates highlights out of the books, not a store of its own", async ({
  page,
}) => {
  await openNotes(page);

  // Two books carry highlights; the third has none and drops out entirely —
  // the page is an index of what was marked, not a catalogue of what was read.
  await expect(page.getByRole("heading", { name: "我们为什么会生病" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "金色梦乡" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "长日将尽" })).toHaveCount(0);

  // The tally is over everything, not over what the filter shows.
  await expect(page.getByText("5 条标注 · 3 条笔记")).toBeVisible();

  // The passage is the row, and it carries the book it came from.
  await expect(row(page, "演化并不设计")).toBeVisible();
  await expect(row(page, "两把钥匙开两把锁")).toHaveCount(0);
  await expect(row(page, "医学擅长处理近因")).toBeVisible();
});

test("search reaches across books and across passage, note and title", async ({ page }) => {
  await openNotes(page);
  const search = page.getByLabel("搜索标注");

  // 演化 is in two different books — a match that spans groups.
  await search.fill("演化");
  await expect(page.getByText("2 / 5 条")).toBeVisible();
  await expect(page.getByRole("heading", { name: "我们为什么会生病" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "金色梦乡" })).toBeVisible();

  // A word the reader wrote, not one the author did.
  await search.fill("修补");
  await expect(page.getByText("1 / 5 条")).toBeVisible();

  // The title, because remembering which book a line came from is the work
  // this page exists to do. The other book's heading drops out with it.
  await search.fill("金色梦乡");
  await expect(page.getByText("2 / 5 条")).toBeVisible();
  await expect(page.getByRole("heading", { name: "我们为什么会生病" })).toHaveCount(0);

  await search.fill("");
  await expect(page.getByText("5 条标注 · 3 条笔记")).toBeVisible();
});

test("the note filter narrows to the highlights that have one", async ({ page }) => {
  await openNotes(page);

  await page.getByRole("button", { name: "有笔记" }).click();
  await expect(page.getByText("3 / 5 条")).toBeVisible();
  await expect(row(page, "演化并不设计")).toBeVisible();
  // This one is a highlight with nothing written on it.
  await expect(row(page, "咳嗽、发烧、呕吐")).toHaveCount(0);

  await page.getByRole("button", { name: "全部" }).click();
  await expect(page.getByText("5 条标注 · 3 条笔记")).toBeVisible();
});

test("a note written here is the note the book carries", async ({ page }) => {
  await openNotes(page);

  const target = row(page, "咳嗽、发烧、呕吐");
  await target.getByRole("button", { name: "添加笔记" }).click();

  const field = target.getByLabel("标注笔记");
  await field.fill("防御本身，不是疾病。");
  // Blur commits; the field has no save button by design.
  await field.blur();

  await expect(target.getByText("防御本身，不是疾病。")).toBeVisible();
  await expect(page.getByText("5 条标注 · 4 条笔记")).toBeVisible();

  // The row is now one of the noted ones, so the filter picks it up — the
  // write went to the same place the filter reads.
  await page.getByRole("button", { name: "有笔记" }).click();
  await expect(page.getByText("4 / 5 条")).toBeVisible();
  await expect(row(page, "咳嗽、发烧、呕吐")).toBeVisible();
});

test("deleting a row deletes the highlight it stands for", async ({ page }) => {
  await openNotes(page);

  const target = row(page, "理解这一点并不会立刻治好什么病");
  await expect(target).toBeVisible();
  await target.getByRole("button", { name: "删除标注" }).click();

  // The row had a note on it, so the note count falls with it.
  await expect(page.getByText("4 条标注 · 2 条笔记")).toBeVisible();
  await expect(row(page, "理解这一点并不会立刻治好什么病")).toHaveCount(0);
  // demo-2 had two highlights and one is gone; the book stays because it
  // still has one.
  await expect(page.getByRole("heading", { name: "金色梦乡" })).toBeVisible();
});

test("a row opens the book at the highlight it stands for", async ({ page }) => {
  await openNotes(page);

  await row(page, "医学擅长处理近因").getByTitle("在书中打开").first().click();

  // The reader mounted. Its own annotation list is the proof that the deep
  // link resolved to a book rather than to an empty reader.
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name: "笔记", level: 1 })).toHaveCount(0);
});
