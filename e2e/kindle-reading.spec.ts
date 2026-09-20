import { expect, test, type Page } from "@playwright/test";

/**
 * The Kindle container path, opened in a browser.
 *
 * Two things are asserted here and they are asserted separately on purpose,
 * because they failed for different reasons and neither one implies the other:
 *
 * 1. **The label.** The reader's report was that a `.azw3` came back as MOBI.
 *    That is a shelf fact — `BookFormat` folds the extension into a name, and
 *    the card prints whatever name it is handed — so it is checked on the
 *    shelf, with no reader involved.
 * 2. **The render.** An AZW3 is a Palm database and goes to foliate rather than
 *    through the prose pipeline, so the shelf's label also decides *which*
 *    renderer the book gets. Every step of that path had been verified by
 *    reading: `isFoliateFormat` picking foliate, `CONTAINER` naming the file,
 *    foliate sniffing `BOOKMOBI` and taking its MOBI6 branch. This is the only
 *    test that opens one.
 *
 * The second is why `?demo=1&kindle=1` exists — see `scripts/generate-demo-kindle.py`
 * for the fixture and `lib/demo.ts` for how it is served.
 *
 * The assertion is deliberately on the book's *own words*, read out of the
 * section document foliate rendered them into. A reader that quietly fell back
 * to the prose pager would show the sample shelf's paragraphs instead, and
 * there would be no section document at all — so the sentence is a
 * discriminator, not decoration. `[data-page-indicator]` would not do: the
 * prose pager draws one of those too.
 */

/** The text of every foliate section document currently mounted. */
async function sectionText(page: Page): Promise<string> {
  // foliate renders each section into its own `blob:` iframe, so the host
  // document holds none of the book's text. Only the sections the paginator
  // has on screen are mounted, which is enough — the reader lands on the
  // first, and that is the one the fixture's opening sentence is in.
  const frames = page.frames().filter((frame) => frame.url().startsWith("blob:"));
  const parts = await Promise.all(
    frames.map((frame) =>
      frame
        .locator("body")
        .innerText()
        .catch(() => ""),
    ),
  );
  return parts.join("\n");
}

test("a .azw3 on the shelf is labelled AZW3, not MOBI", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&kindle=1");

  const card = page.getByRole("button", { name: /Kindle 样书/ }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("AZW3");
  // The defect, pinned: AZW3 and MOBI share a container and a parser, and the
  // shelf used to say so by printing the family's older name.
  await expect(card, "AZW3 不该再被折叠成 MOBI 标签").not.toContainText("MOBI");
});

test("an AZW3 opens in foliate and renders its own text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&kindle=1");
  await page
    .getByRole("button", { name: /Kindle 样书/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });

  // The container parsed. `makeBook` throws on a file it cannot sniff and
  // foliate's MOBI6 `init()` throws on one it can sniff but not read; either
  // one surfaces as this message instead of a book, and both are silent in the
  // unit tests because neither runs a browser.
  await expect(page.getByText(/Kindle 容器打不开/)).toHaveCount(0);

  await expect
    .poll(() => sectionText(page), {
      timeout: 10_000,
      message: "AZW3 的正文没有出现在任何 section 文档里",
    })
    .toContain("AZW3 与 MOBI 是同一个容器");

  // The heading is in the same section as that sentence, from the fixture's
  // own `<h1>` — so this also says foliate kept the markup rather than
  // flattening the page to a run of text.
  expect(await sectionText(page)).toContain("第一章 同一个容器");
});
