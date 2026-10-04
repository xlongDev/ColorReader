import { expect, test, type Page } from "@playwright/test";

/**
 * The read-aloud wash's settings, and the one path whose paint can be read back.
 *
 * A wash only exists while the voice is speaking, and a headless browser has
 * nothing to speak with — so what is pinned here is the wiring on either side of
 * the paint: the panel writes the setting, the reader turns it into the
 * `::highlight` rule pdf.js paints through, and both survive a reload. What the
 * declarations say is `ttsWash.test.ts`'s business.
 */

/** The rule the PDF path installs, rather than a rule in the stylesheet: the
 *  wash is a setting, and `::highlight` has no element to hang one on. */
const TTS_RULE = "#pdf-tts-wash";

const ruleText = (page: Page) =>
  page
    .locator(TTS_RULE)
    .evaluate((el) => el.textContent ?? "")
    .catch(() => "");

/** The wash's own alpha, and how light it is.
 *
 *  Both are read out of the rule rather than compared as literal colours,
 *  because the wash is *mixed against the page it sits on* — the app darkens a
 *  light wash so it stays legible on dark paper. That mixture lands on a slightly
 *  different surface wherever the type metrics differ, and a runner without the
 *  CJK font duly produced `rgba(50, 50, 14, 0.36)` where this file had written
 *  `rgba(0, 0, 0, 0.36)`. The two facts worth pinning are "the wash is as
 *  transparent as the reader asked for" and "it followed the page", both of which
 *  survive the platform. */
async function wash(page: Page): Promise<{ alpha: string; light: number }> {
  const text = await ruleText(page);
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(text);
  if (!match) return { alpha: "", light: -1 };
  const [r, g, b] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  return { alpha: match[4] ?? "", light: (r + g + b) / 3 };
}

async function openBook(page: Page, query: string, book: RegExp): Promise<void> {
  await page.goto(query);
  await page.getByRole("button", { name: book }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(900);
}

/** Opens the settings drawer and brings the speaker section into view: it sits
 *  under the typography groups, which alone are taller than the drawer. */
async function openSpeech(page: Page): Promise<void> {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByText("高亮样式", { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
}

test("the wash's shape and ink are the reader's, and they outlive the session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await openSpeech(page);

  const shape = page.getByRole("combobox", { name: "高亮样式" });

  // The shipping wash is the app's own tint, and the row offers no way back to
  // it because it has not been left.
  await expect(shape).toHaveValue("highlight");
  await expect(page.getByRole("button", { name: "跟随主题色" })).toHaveCount(0);

  // 快速颜色 leads with the palette the selection toolbar already shows.
  await page.getByRole("button", { name: "高亮颜色 #56aee2" }).click();
  await expect(page.getByRole("button", { name: "跟随主题色" })).toBeVisible();

  // And any hex the reader already has — off a design tool, off another app's
  // picker — not only the five in the row.
  const hex = page.getByLabel("高亮颜色十六进制值");
  await hex.fill("#FF69B4");
  await hex.press("Enter");
  await expect(hex).toHaveValue("#ff69b4");
  await page.getByRole("button", { name: "固定当前颜色" }).click();
  await expect(page.getByRole("button", { name: "高亮颜色 #ff69b4" })).toBeVisible();

  // A value that is not a colour says so while it is typed, and puts the old
  // ink back rather than storing something no renderer can draw. (`#56a` would
  // be a colour — three digits are CSS shorthand.)
  await hex.fill("#56aee");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await page.getByText("高亮样式", { exact: true }).click();
  await expect(hex).toHaveValue("#ff69b4");

  await shape.selectOption("squiggly");
  await page.getByRole("button", { name: "简约" }).click();

  await page.reload();
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await openSpeech(page);
  await expect(page.getByRole("combobox", { name: "高亮样式" })).toHaveValue("squiggly");
  await expect(page.getByRole("button", { name: "高亮颜色 #ff69b4" })).toBeVisible();
  await expect(page.getByRole("button", { name: "简约" })).toHaveAttribute("aria-pressed", "true");

  // Back to the theme tint: the disc wears the token, not a hex copied from it.
  await page.getByRole("button", { name: "跟随主题色" }).click();
  await expect(page.getByRole("button", { name: "跟随主题色" })).toHaveCount(0);
});

test("the PDF wash is installed as a rule, and it follows the setting", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1&pdf=1", /PDF 样书/);

  // Installed on open, before anything is spoken: the rule is the wash's
  // appearance, and the ranges are painted onto it separately.
  await expect.poll(() => ruleText(page)).toContain("background-color: var(--accent-soft)");

  await openSpeech(page);
  await page.getByRole("combobox", { name: "高亮样式" }).selectOption("strikethrough");
  await expect.poll(() => ruleText(page)).toContain("text-decoration: line-through;");
  // The weight is a length in the rule, or the browser drops it.
  await expect.poll(() => ruleText(page)).toContain("text-decoration-thickness: 2px;");

  await page.getByRole("button", { name: "高亮颜色 #ffd12e" }).click();
  await expect.poll(() => ruleText(page)).toContain("text-decoration-color: #ffd12e;");

  // A marker band, in the alphas the annotation highlights use — 0.36 on the
  // day paper this run defaults to, 0.26 on the night one.
  await page.getByRole("combobox", { name: "高亮样式" }).selectOption("highlight");
  await expect.poll(() => ruleText(page)).toContain("background-color: rgba(255, 209, 46, 0.36);");
  await expect.poll(() => ruleText(page)).not.toContain("text-decoration");

  // 轮廓 is drawn around the letters rather than as a box: an `outline` on a
  // run of text that wraps is a rectangle spanning every line it touches.
  await page.getByRole("combobox", { name: "高亮样式" }).selectOption("outline");
  await expect.poll(() => ruleText(page)).toContain("text-shadow: 1px 0 0 #ffd12e");

  // The picker writes through to the same rule — and none of it goes through
  // `<input type="color">`, which is what used to hand the choice to the OS and
  // open a picker outside the sheet (a floating panel in the browser, a native
  // colour window on the desktop).
  await page.getByRole("combobox", { name: "高亮样式" }).selectOption("highlight");
  await expect(page.locator('input[type="color"]')).toHaveCount(0);

  const hex = page.getByLabel("高亮颜色十六进制值");
  await hex.fill("#ff0000");
  await hex.press("Enter");
  await expect.poll(() => ruleText(page)).toContain("rgba(255, 0, 0, 0.36)");

  await page.getByLabel("色相").fill("60");
  await expect.poll(() => ruleText(page)).toContain("rgba(255, 255, 0, 0.36)");

  // Dragged clear of the pad, so the corners are the assertions that survive
  // rounding: clamping makes them exact, where a click "roughly in the middle"
  // would pin a pixel to a colour.
  const pad = page.locator("[data-color-pad]");
  const box = (await pad.boundingBox())!;
  const drag = async (toX: number, toY: number) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 3 });
    await page.mouse.up();
  };

  await drag(box.x - 40, box.y - 40);
  await expect.poll(async () => (await wash(page)).alpha).toBe("0.36");
  const onLight = await wash(page);

  // …and the other way round: the same wash, dragged onto the dark page, comes
  // out dark. Compared light-against-dark rather than against two literals.
  await drag(box.x + box.width + 40, box.y + box.height + 40);
  await expect.poll(async () => (await wash(page)).alpha).toBe("0.36");
  const onDark = await wash(page);
  expect(onDark.light).toBeLessThan(onLight.light);
});
