import { expect, test, type Locator } from "@playwright/test";

/**
 * The 搜索 button in 在线找书, and the one way it has been wrong.
 *
 * The row is a flex line: `GlassInput` (which ships `w-full`, so it wants the
 * whole line as its basis) next to `GlassButton`. With only `flex-shrink`, the
 * input's 100% basis eats the space and the button gets squeezed to its
 * min-content. `h-9` pins the button's *height*, so a squeezed button does not
 * look too small — it looks deformed: the two CJK characters of 「搜索」 break
 * onto separate lines, stacked under each other beside the icon.
 *
 * `h-9` is exactly why this needs its own test: a height assertion passes on the
 * broken layout. What actually distinguishes the two states is whether the label
 * occupies one text line or two, and that is read here from the number of client
 * rects a Range over the label produces — one per line box. This runs on both
 * engines because the squeeze is a flex-basis problem and both reflow it the
 * same way, but the CJK line-break is where a divergence would show up first.
 */

/** How many line boxes the button's label text is laid out on. */
async function labelLineCount(button: Locator): Promise<number> {
  return button.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let rects = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const range = document.createRange();
      range.selectNodeContents(node);
      rects += range.getClientRects().length;
    }
    return rects;
  });
}

test.describe("在线找书 · search row geometry", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?demo=1");
    // 「在线找书」 is a chrome button on the shelf header.
    await page.getByRole("button", { name: "在线找书" }).first().click();
    await expect(page.locator("[role='dialog']")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "搜索关键词" })).toBeVisible();
  });

  test("搜索 label stays on one line and the row reads as one band", async ({ page }) => {
    const input = page.getByRole("textbox", { name: "搜索关键词" });
    const button = page.getByRole("button", { name: /搜索/ }).last();
    await expect(button).toBeVisible();

    // The deformation itself: one line, not two stacked characters.
    expect(await labelLineCount(button)).toBe(1);

    // And the row it sits in: input and button adjacent (the `gap-2` band, not a
    // gulf), the button the same height as the input, both inside the dialog.
    const [inputBox, buttonBox] = await Promise.all([input.boundingBox(), button.boundingBox()]);
    expect(inputBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();

    const gap = buttonBox!.x - (inputBox!.x + inputBox!.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);

    // h-9 on both — a wrapped label would not change this, which is the point.
    expect(buttonBox!.height).toBeCloseTo(inputBox!.height, 0);

    const dialog = await page.locator("[role='dialog']").boundingBox();
    expect(dialog).not.toBeNull();
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(dialog!.x + dialog!.width + 1);
  });
});
