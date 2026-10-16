/**
 * 金句卡片 — the share card, in the browser.
 *
 * Three claims about the card are structural, and none of them is visible to
 * a unit test, which is why it has a spec of its own:
 *
 * 1. It draws at **its own pixel size** (1080x1440) whatever the preview
 *    shows it at — a card sized to the preview would share a thumbnail.
 * 2. The canvas holds **more than one colour**: paper, marker wash, ink, the
 *    wordmark and the QR plate. A blank paper is the failure this catches.
 * 3. The **QR plate stays white** on every surface — including a night one,
 *    where the card's own ink is too pale to scan.
 *
 * The browser has no save panel, so 保存图片 is a download: the file is the
 * artifact the desktop's `card.save` would have written, and its PNG header
 * is read off the download itself.
 *
 * `?demo=1` carries sample highlights for the first sample book (see
 * `lib/demo.ts`), so the drawer opens with something to share.
 */
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

test("金句卡片画在自己的纸上，保存成 PNG", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1");

  await page.getByRole("button", { name: "我们为什么会生病" }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 20_000,
  });

  // The drawer, over the annotations this demo book carries.
  await page.getByRole("button", { name: "标注", exact: true }).click();
  await expect(page.getByText("3 条标注")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "分享这一句" }).first().click();

  const canvas = page.getByLabel("金句卡片预览");
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("button", { name: "保存图片" })).toBeEnabled({ timeout: 20_000 });

  // The card's own pixels: the size, and a canvas that actually drew.
  const drawn = await page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>('canvas[aria-label="金句卡片预览"]');
    if (!element) return null;
    const context = element.getContext("2d");
    if (!context) return null;
    const { data } = context.getImageData(0, 0, element.width, element.height);
    const colors = new Set<string>();
    for (let index = 0; index < data.length; index += 4 * 97) {
      colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    }
    // 22px inside the plate's top-left corner: past the rounded border,
    // before the first module row — the one guaranteed-white spot on any
    // paper, day or night.
    const plate = context.getImageData(790, 1150, 1, 1).data;
    return {
      width: element.width,
      height: element.height,
      colors: colors.size,
      plate: [plate[0], plate[1], plate[2]],
    };
  });
  expect(drawn).not.toBeNull();
  expect(drawn!.width).toBe(1080);
  expect(drawn!.height).toBe(1440);
  // Paper, ink, wash, wordmark, plate: a blank card would hold one colour.
  expect(drawn!.colors).toBeGreaterThanOrEqual(4);
  expect(drawn!.plate[0]).toBeGreaterThan(240);
  expect(drawn!.plate[1]).toBeGreaterThan(240);
  expect(drawn!.plate[2]).toBeGreaterThan(240);

  // No save panel in a browser: the card lands as a download.
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "保存图片" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("我们为什么会生病.png");
  const bytes = readFileSync((await file.path())!);
  expect(bytes.length).toBeGreaterThan(1000);
  expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});
