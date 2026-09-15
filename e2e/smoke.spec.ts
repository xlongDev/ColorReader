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

  // Lazy route chunks: first navigation triggers the network fetch. The
  // outgoing page stays mounted for the cross-fade, and it carries a search
  // field of its own, so the assertion has to pick the incoming one.
  await page.getByRole("link", { name: "搜索" }).click();
  await expect(page.getByPlaceholder("搜索正文").first()).toBeVisible();

  // 设置 is the sidebar footer's gear button, not a nav link. The route
  // cross-fade keeps the outgoing page mounted for a beat — and the incoming
  // one can sit in the tree more than once while it settles — so assert on the
  // settled state rather than on the first paint.
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("navigation", { name: "设置分类" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "外观" })).toHaveCount(1);

  await page.getByRole("link", { name: "书库" }).click();
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();

  expect(pageErrors, "console/page errors must stay empty").toEqual([]);
});
