import { expect, test, type Page } from "@playwright/test";

/**
 * 打开一本书的第一帧就已经是读者选定的排版。
 *
 * 读者报的是「先双页，一瞬间又变单页」：foliate 的 paginator 默认
 * `--_max-column-count: 2`，而 `applyLayout` 原本排在 `init()` 之后 ——
 * 于是第一页先按跨页排出来，等布局 effect 跑完再重排成单页。
 *
 * 所以断言的不是「最终是单页」（那在修好之前也成立），而是**每一次渲染**
 * 的列数：`stabilized` 是 `render()` / `#display` 的收尾事件，而
 * `columnCount` 是那次渲染实际用的列数。第一次渲染就得是 1，且全程不该
 * 出现 2 —— 把 `applyLayout` 挪回 `init()` 之后，第一条渲染就是 2。
 */

/** 每一次分页渲染的列数，按发生顺序。 */
const RENDERS = `window.fangceLayoutRenders`;

/**
 * 在页面任何脚本之前挂上记录器。
 *
 * 监听必须在 `init()` 之前就位，所以不能等书打开后再找元素：观察
 * `document` 直到 `foliate-view` 出现，再观察它的 shadow root 直到
 * `foliate-paginator` 出现。分页器一挂上还没有任何 section，第一次
 * `render()` 要等 `init()` 拉完 section，记录器来得及。
 */
async function recordRenders(page: Page) {
  await page.addInitScript(() => {
    const renders: number[] = [];
    (window as unknown as { fangceLayoutRenders: number[] }).fangceLayoutRenders = renders;
    const watch = (target: Node, bind: () => boolean) => {
      if (bind()) return;
      const observer = new MutationObserver(() => {
        if (bind()) observer.disconnect();
      });
      observer.observe(target, { childList: true, subtree: true });
    };
    // 观察 `document` 而不是 `document.documentElement`：init script 跑在
    // document start，此刻根元素还不存在。
    watch(document, () => {
      const shadow = document.querySelector("foliate-view")?.shadowRoot;
      if (!shadow) return false;
      watch(shadow, () => {
        const pager = shadow.querySelector("foliate-paginator") as
          (HTMLElement & { columnCount: number }) | null;
        if (!pager) return false;
        pager.addEventListener("stabilized", () => renders.push(pager.columnCount));
        return true;
      });
      return true;
    });
  });
}

/** 打开样书，等它排好版。 */
async function openSample(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&epub=1");
  await page
    .getByRole("button", { name: /页码样书/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
}

test("打开一本书，第一次渲染就是单页，不会先闪一页双页", async ({ page }) => {
  await recordRenders(page);
  await openSample(page);

  await expect
    .poll(() => page.evaluate(`${RENDERS}.length`), { timeout: 10_000 })
    .toBeGreaterThan(0);
  const renders: number[] = await page.evaluate(RENDERS);

  expect(renders[0], "第一次渲染就已经是单页").toBe(1);
  expect(renders, "全程不该出现一次双页渲染").not.toContain(2);
});

/**
 * 一次切换只付一次重排的钱。
 *
 * 每条布局属性都是一次整节重排（WebKit 上一本单节书约 1 秒），而切一次
 * 排版只该动一条属性；分页器自己还会因为容器尺寸变了再重排一遍，那一遍
 * 算出来的版式与上一次一模一样。这里钉住「切换 = 一次重排」，两条都得在：
 * `applyLayout` 只写变了的值，分页器跳过重复版式。
 */
test("切换单页 → 双页只重排一次", async ({ page }) => {
  await recordRenders(page);
  await openSample(page);
  // 开书那几次渲染先落定，别算进切换的账。
  await page.waitForTimeout(1500);
  const before = await page.evaluate<number>(`${RENDERS}.length`);

  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "双页", exact: true }).first().click();
  await page.waitForTimeout(2000);

  const after: number[] = await page.evaluate(RENDERS);
  const switched = after.slice(before);
  expect(switched, "一次切换只该重排一次").toHaveLength(1);
  expect(switched[0], "并且真的排成了双页").toBe(2);
});
