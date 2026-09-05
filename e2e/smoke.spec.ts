import { expect, test } from "@playwright/test";

// Smoke E2E over the production build (`pnpm build` output, served by
// `vite preview`). Outside the Tauri shell the data layer is empty, so every
// page must render its empty state; the point is that each route chunk loads
// and nothing throws.

test("all routes render without console errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();

  // Lazy route chunks: first navigation triggers the network fetch.
  await page.getByRole("link", { name: "搜索" }).click();
  await expect(page.getByPlaceholder("搜索正文")).toBeVisible();

  await page.getByRole("link", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "外观" })).toBeVisible();

  await page.getByRole("link", { name: "书库" }).click();
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();

  expect(pageErrors, "console/page errors must stay empty").toEqual([]);
});
