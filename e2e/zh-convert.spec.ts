import { expect, test, type Page } from "@playwright/test";

/**
 * 简繁转换 and 替换引号 — the two settings that live in a section's *text*
 * rather than in the injected stylesheet.
 *
 * Neither can be expressed as CSS, so both are applied to the mounted section
 * document and have to survive a flip in place: the paginator reuses an
 * already-mounted view when `goTo` lands on the section it is on and never
 * re-fires `load` (paginator.js:3812), so the route these settings used to take
 * — flip, then re-open the view — did nothing inside the chapter the reader was
 * actually on. Turning 替换引号 off used to leave the corner brackets on the
 * page; these tests are the ones that would have caught it.
 *
 * What is asserted is the text itself, read out of the section documents, and
 * always as a relation (`has` / `has not`) rather than an exact string: the
 * demo fixture repeats a pool of paragraphs, so which paragraph is on screen is
 * the layout's business, and WebKit paginates the same EPUB differently from
 * Chromium. The characters, on the other hand, are the contract.
 *
 * Both books are covered because they take different paths: the EPUB goes
 * through foliate's section documents (`sectionText.ts` replays the layers
 * over the published text), the plain-text sample through the prose pipeline
 * (`ReaderPage::displayChapterData`, which every consumer — rendering, the
 * selection resolver, the read-aloud queue, the AI context — reads from).
 */

/** The text of the first section document with any content on it. */
async function sectionText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const frames = view?.shadowRoot
      ?.querySelector("foliate-paginator")
      ?.shadowRoot?.querySelectorAll("iframe");
    for (const frame of frames ?? []) {
      const text = frame.contentDocument?.body?.textContent ?? "";
      if (text.trim()) return text;
    }
    return "";
  });
}

/** The prose path's text: this document, no iframe involved. */
async function proseText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector("[data-reading-content]");
    return root?.textContent ?? "";
  });
}

/** Opens a sample book and settles on the reader's first page. */
async function openReader(page: Page, { query, title }: { query: string; title: RegExp }) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(query);
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(800);
}

/** The header's 简繁转换 button, whatever mode it is currently in. */
const zhButton = (page: Page) => page.getByRole("button", { name: /^简繁转换/ }).first();

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
}

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
}

/** One group of the settings drawer, by its label. Assumes the drawer is open. */
const group = (page: Page, label: string) =>
  page
    .locator("aside div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .last();

/** Picks a mode from the button's menu and waits for the page to catch up. */
async function pickMode(page: Page, label: string, expectText: RegExp) {
  await zhButton(page).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  // The dictionaries are a lazy chunk, so the rewrite lands a beat after the
  // click. Poll the page instead of sleeping a guessed interval.
  await page.waitForFunction(
    (source: string) => {
      const view = document.querySelector("foliate-view");
      const frames = view?.shadowRoot
        ?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelectorAll("iframe");
      for (const frame of frames ?? []) {
        if (new RegExp(source).test(frame.contentDocument?.body?.textContent ?? "")) return true;
      }
      return /发烧|發燒/.test(document.querySelector("[data-reading-content]")?.textContent ?? "");
    },
    expectText.source,
    { timeout: 15_000 },
  );
}

test.describe("简繁转换", () => {
  test("默认不改写：正文保持书页出厂时的字形", async ({ page }) => {
    await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
    const text = await sectionText(page);
    expect(text, "section 文本没读到").not.toBe("");
    expect(text).toContain("发烧");
    expect(text).not.toContain("發燒");
  });

  test("简→繁改写正文，切回繁→简逐字还原", async ({ page }) => {
    await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
    const before = await sectionText(page);

    await pickMode(page, "简 → 繁", /身體/);
    const converted = await sectionText(page);
    expect(converted).toContain("身體");
    expect(converted).not.toContain("身体");

    await pickMode(page, "繁 → 简", /身体/);
    // Back to the book's own characters, not merely to something else.
    expect(await sectionText(page)).toBe(before);
  });

  test("纯文本书走同一条设置，转换在段落上生效", async ({ page }) => {
    await openReader(page, { query: "/?demo=1", title: /我们为什么会生病/ });
    expect(await proseText(page)).toContain("发烧");

    await zhButton(page).click();
    await page.getByRole("menuitemradio", { name: "简 → 繁", exact: true }).click();
    await page.waitForFunction(
      () => /發燒/.test(document.querySelector("[data-reading-content]")?.textContent ?? ""),
      undefined,
      { timeout: 15_000 },
    );
    const text = await proseText(page);
    expect(text).toContain("發燒");
    expect(text).not.toContain("发烧");
  });

  test("图标可以在阅读设置里关掉、再打开", async ({ page }) => {
    await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
    await expect(zhButton(page)).toBeVisible();

    await openSettings(page);
    const toggle = group(page, "简繁转换").getByRole("switch", {
      name: "在工具栏显示简繁转换按钮",
    });
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    await closeSettings(page);
    await expect(zhButton(page)).toHaveCount(0);

    // …and back: the shortcut is not a one-way door.
    await openSettings(page);
    await group(page, "简繁转换").getByRole("switch", { name: "在工具栏显示简繁转换按钮" }).click();
    await closeSettings(page);
    await expect(zhButton(page)).toBeVisible();
  });
});

test.describe("替换引号", () => {
  /**
   * 替换引号 rewrites the western curly quotes into the corner brackets
   * vertical CJK is set with — and the panel only offers it while the layout is
   * vertical, which is the setting the demo book is put into here.
   *
   * The fixture has no curly quotes of its own, so one is injected into the
   * section document: what is under test is the wiring (the flip reaches the
   * mounted section), not the book's punctuation.
   */
  test("开→关逐字还原，且与简繁转换互不覆盖", async ({ page }) => {
    await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });

    // 竖排 first: that is the only layout the panel offers 替换引号 under, and
    // changing the axis re-opens the view — so the probe goes in afterwards.
    await openSettings(page);
    await group(page, "排版方向").getByRole("button", { name: "竖排", exact: true }).click();
    await closeSettings(page);
    await page.waitForTimeout(2000);

    const inject = () =>
      page.evaluate(() => {
        const view = document.querySelector("foliate-view");
        const frames = view?.shadowRoot
          ?.querySelector("foliate-paginator")
          ?.shadowRoot?.querySelectorAll("iframe");
        for (const frame of frames ?? []) {
          const doc = frame.contentDocument;
          if (!doc?.body?.textContent?.trim()) continue;
          const probe = doc.createElement("p");
          probe.id = "quote-probe";
          probe.textContent = "他说：“内存”。";
          doc.body.append(probe);
          return true;
        }
        return false;
      });
    expect(await inject(), "没找到可注入的 section").toBe(true);

    const probe = () =>
      page.evaluate(() => {
        const view = document.querySelector("foliate-view");
        const frames = view?.shadowRoot
          ?.querySelector("foliate-paginator")
          ?.shadowRoot?.querySelectorAll("iframe");
        for (const frame of frames ?? []) {
          const el = frame.contentDocument?.getElementById?.("quote-probe");
          if (el) return el.textContent ?? "";
        }
        return "";
      });

    // 关 → 替换
    await openSettings(page);
    await group(page, "替换引号").getByRole("button", { name: "替换", exact: true }).click();
    // Polled rather than slept on: the rewrite lands within the frame, and the
    // dictionaries behind the second layer arrive in a lazy chunk.
    await expect.poll(() => probe(), { timeout: 10_000 }).toBe("他说：﹁内存﹂。");

    // 替换 → 关: the brackets go back to the book's own quotes.
    await group(page, "替换引号").getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => probe(), { timeout: 10_000 }).toBe("他说：“内存”。");

    // 简繁转换 comes along without touching the other layer: with 替换引号 off,
    // the probe's 内存 becomes 內存 and the quotes stay the book's own — the
    // conversion replays from the published text, so it neither reinstates the
    // brackets nor drops them.
    await closeSettings(page);
    await zhButton(page).click();
    await page.getByRole("menuitemradio", { name: "简 → 繁", exact: true }).click();
    await expect.poll(() => probe(), { timeout: 15_000 }).toBe("他說：“內存”。");

    // …and turning the quotes back on layers on top of the converted text
    // rather than replacing it: the two settings share one pipeline, and each
    // replay starts from the characters the book published.
    await openSettings(page);
    await group(page, "替换引号").getByRole("button", { name: "替换", exact: true }).click();
    await expect.poll(() => probe(), { timeout: 10_000 }).toBe("他說：﹁內存﹂。");
  });
});
