import { expect, test } from "@playwright/test";

/**
 * Where 返回 leads, and what the shelf remembers on the way.
 *
 * Neither is visible to the unit suite: both only exist *across* a route
 * change, and the shelf is unmounted for as long as a book is open. So an
 * arrangement held in component state does not survive the trip, even though
 * the reader looks like it is coming back to the same place — and a reader
 * that always navigates to `/` sends a reader who came from 笔记 to 书库.
 *
 * `?demo=1` supplies the fixture books. It has to ride in on the boot
 * navigation (`/?demo=1`) because the router is a memory router and always
 * starts on the shelf; see `e2e/notes-page.spec.ts` for the full reason.
 */

const VIEWPORT = { width: 1280, height: 800 };

/** The shelf's covers are buttons; the 续读 card's is one too, and either
 *  opens the book. */
const COVER = "button:has([data-book-cover])";

/** The two words inside the direction toggle's slot. */
const WORDS = "button[aria-label^='当前'] span > span";

test("the shelf comes back in the order it was left in", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  const order = page.getByLabel("排序方式");
  await order.selectOption("titleAsc");
  await expect(order).toHaveValue("titleAsc");

  await page.locator(COVER).first().click();
  await page.getByRole("button", { name: "返回书库" }).first().click();

  // The shelf is back, and it remembered. A store is what makes this true:
  // the old `useState` was remounted with the route.
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await expect(page.getByLabel("排序方式")).toHaveValue("titleAsc");
});

test("an arrangement survives a reload, not just a trip into a book", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  await page.getByLabel("排序方式").selectOption("authorAsc");
  await page.getByLabel("分组方式").selectOption("format");

  // A reload is a different path from a route change: the store has to come
  // back out of localStorage, and a memory router means the URL says nothing
  // about where the shelf was.
  await page.reload();
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await expect(page.getByLabel("排序方式")).toHaveValue("authorAsc");
  await expect(page.getByLabel("分组方式")).toHaveValue("format");
});

test("leaving the reader goes back to the shelf it was opened from", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  await page.getByRole("link", { name: "最近", exact: true }).click();
  await expect(page.getByRole("heading", { name: "最近" })).toBeVisible();

  await page.locator(COVER).first().click();
  await page.getByRole("button", { name: "返回书库" }).first().click();

  // 最近, not 书库: 返回 used to hard-code `/`, which made the trip out of
  // every shelf but the first one a one-way door.
  await expect(page.getByRole("heading", { name: "最近" })).toBeVisible();
});

test("a book opened from 笔记 goes back to 笔记, and the button says so", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  await page.getByRole("link", { name: "笔记", exact: true }).click();
  const notes = page.locator("[data-notes-page]");
  await expect(notes).toBeVisible();

  // Narrowed first, so the trip can be seen to bring it back: a query held in
  // component state went with the page when it unmounted.
  const search = notes.getByLabel("搜索标注");
  await search.fill("身体");
  await expect(search).toHaveValue("身体");

  await notes
    .getByRole("button", { name: /身体是一台被反复修补过的机器/ })
    .first()
    .click();

  const back = page.getByRole("button", { name: "返回笔记" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.locator("[data-notes-page]")).toBeVisible();
  await expect(page.locator("[data-notes-page]").getByLabel("搜索标注")).toHaveValue("身体");
});

/**
 * The direction toggle under `prefers-reduced-motion`.
 *
 * Asserted on the end state rather than on the frames between, which is the
 * only part that is deterministic: with motion asked for, the two words park
 * off-slot and travel; with motion reduced they both sit still and only
 * cross-fade. Measuring mid-flight would be a flake, not a test.
 */
test("with motion reduced the toggle swaps its words in place, without sliding", async ({
  page,
}) => {
  // Emulated on the page rather than through `test.use({ reducedMotion })`:
  // the fixture sets it on the context, and the shelf did not see it — the
  // words were still parked 20px off-slot, which is the un-reduced value.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  const words = page.locator(WORDS);
  const rest = () =>
    words.evaluateAll((els) =>
      els.map((el) => ({
        y: Math.round(new DOMMatrixReadOnly(getComputedStyle(el).transform).f),
        opacity: Number(getComputedStyle(el).opacity),
      })),
    );

  const before = await rest();
  expect(before.map((w) => w.y)).toEqual([0, 0]);
  expect(before.map((w) => w.opacity).toSorted()).toEqual([0, 1]);

  await page.getByRole("button", { name: /当前/ }).click();
  // Past the vocabulary's `DURATION.fast`, which is the whole transition once
  // there is no travel left to wait for.
  await page.waitForTimeout(400);

  const after = await rest();
  // Still in the slot: no travel is the entire point.
  expect(after.map((w) => w.y)).toEqual([0, 0]);
  // And the words did trade places — without this the assertion above would
  // pass just as happily on a control that never changed at all.
  expect(after.map((w) => w.opacity).toSorted()).toEqual([0, 1]);
  expect(after[0]?.opacity).toBe(before[0]?.opacity === 1 ? 0 : 1);
});
