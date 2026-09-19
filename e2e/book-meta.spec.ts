import { expect, test } from "@playwright/test";

/**
 * The metadata sheet, from the card's hover action to the form it opens.
 *
 * The web preview has no backend, so nothing here can assert that a save lands
 * — `ipc.bookUpdate` has nothing to talk to under `?demo=1`. What it does pin
 * down is the part with no unit test: the fifth hover action exists, is
 * reachable with a pointer (the row is `pointer-events: none` until the card is
 * hovered, so a `force: true` click would hide the exact failure this catches),
 * and it opens pre-filled with *that* card's book.
 *
 * The form's own rules — the comma split, the disabled save, the empty title —
 * are covered in `BookMetaDialog.test.tsx`; the two assertions here are the
 * ones that would otherwise only be checkable by hand.
 */
test("a shelf card opens the metadata sheet pre-filled", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  await page.locator("[data-book-cover]").first().hover();

  const edit = page.getByRole("button", { name: "编辑信息" }).first();
  await expect(edit).toBeVisible();
  await edit.click();

  // The first sample book — `TITLES[0]` and `AUTHORS[0]` in `lib/demo.ts`.
  //
  // `exact` throughout: the shelf's own search box is labelled "搜索书名或作者",
  // which a substring match for "书名" happily accepts — it resolved to the
  // search field first and the assertion read its empty value.
  const title = page.getByRole("textbox", { name: "书名", exact: true });
  await expect(title).toHaveValue("我们为什么会生病");
  await expect(page.getByRole("textbox", { name: "作者", exact: true })).toHaveValue(
    "伦道夫·尼斯, 乔治·威廉斯",
  );

  // Nothing touched yet: the sheet must not offer to save a no-op.
  const save = page.getByRole("button", { name: "保存" });
  await expect(save).toBeDisabled();

  await title.fill("我们为什么会生病 II");
  await expect(save).toBeEnabled();

  // The one rule the backend enforces, answered before the round trip.
  await title.fill("");
  await expect(page.getByText("书名不能为空。")).toBeVisible();
  await expect(save).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(title).toHaveCount(0);
});
