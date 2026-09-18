import { expect, test, type Page } from "@playwright/test";

/**
 * The reader's selection toolbar.
 *
 * The unit suite covers the note field's logic, but two of the three contracts
 * here are invisible to it, and both were found by measuring rather than by
 * reading:
 *
 * 1. Where the panel lands. jsdom has no layout at all, so the placement maths
 *    can only be checked against a real engine. It used to be computed from a
 *    hardcoded height — 84 closed, 144 with the note field open — and the
 *    clamp was measured against *those numbers*. Reality was 91 and 186, and
 *    the 42px gap arrived with the note field's action strip, so for a
 *    selection in that band the panel hung past the page's foot. It is
 *    measured from the panel's own height now.
 *
 * 2. Whether a press on the panel's own controls counts as leaving it. jsdom
 *    focuses a button on mousedown, the way Chrome does — but WebKit, which is
 *    the engine this app ships on (Tauri is WKWebView), does not. Focus falls
 *    to `body`, the field's focusout arrives with `relatedTarget: null`, and
 *    the panel's own guard read that as "the reader left": the note committed,
 *    the field unmounted, and the button's click never landed. 清空 and 删除
 *    were dead buttons in the shipping engine and worked in the dev one.
 *
 * `?demo=1` supplies the sample books and their highlights; without it the web
 * build has nothing to open.
 */

const BOOK = /我们为什么会生病/;
const PANEL = "[data-toolbar-rev]";
/** An annotation-backed run in the prose: tapping one opens the toolbar in
 *  edit mode, which is where 删除笔记 has anything to act on. */
const MARK = '[data-reading-content] a[href^="#note-"]';

async function openBook(page: Page) {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: BOOK }).first().click();
  await page.waitForSelector("[data-reading-content] p", { timeout: 15_000 });
  await page.waitForTimeout(900);
}

/**
 * Selects part of the lowest paragraph still inside the content box, fires the
 * mouseup the reader's own handler listens for, and reports the selection's own
 * box alongside the reading area's.
 *
 * The selection's rect is what gives the assertion below its power. The old
 * code computed the panel's top from a height 42px short of the real one, so
 * whenever it placed the panel *above* the words it put the panel's foot 40px
 * below their top — on top of the line being annotated. That holds for any
 * selection in the lower half of the page, not just one band of it. (Asserting
 * only that the panel stays inside the area was tried first and passed against
 * the broken code: the overflow it caused needs the selection inside a 42px
 * band, and none of these window heights landed in it.)
 *
 * The helpers stay inside `page.evaluate` on purpose: it serialises the
 * function and runs it in the browser, where nothing from module scope exists.
 */
async function selectLowestParagraph(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector("[data-reading-content]");
    if (!content) return { ok: false as const, why: "no [data-reading-content]" };
    const box = content.getBoundingClientRect();
    const usable = [...content.querySelectorAll("[data-para-idx]")].filter((p) => {
      const r = p.getBoundingClientRect();
      return r.bottom < box.bottom - 20 && r.top > box.top;
    });
    const target = usable.at(-1);
    if (!target) return { ok: false as const, why: `no usable paragraph of ${usable.length}` };
    const text = [...target.childNodes].find(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 8,
    );
    if (!text) return { ok: false as const, why: "no long text node" };
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(12, (text.textContent ?? "").trim().length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const r = range.getBoundingClientRect();
    return {
      ok: true as const,
      selTop: Math.round(r.top),
      selBottom: Math.round(r.bottom),
      areaTop: Math.round(box.top),
      areaBottom: Math.round(box.bottom),
    };
  });
}

/** The panel's box, in window coordinates. */
function panelBox() {
  const panel = document.querySelector("[data-toolbar-rev]");
  if (!panel) return null;
  const p = panel.getBoundingClientRect();
  return { top: Math.round(p.top), bottom: Math.round(p.bottom) };
}

test("the note field never pushes the panel off the page or over the words", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openBook(page);

  // A shorter window moves the last paragraph towards the content's foot, which
  // is where the placement has the least room and the old constants failed.
  // Varying the frame rather than the content keeps the fixture untouched.
  for (const height of [820, 620, 500, 420]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(350);

    const picked = await selectLowestParagraph(page);
    expect(picked.ok, `a paragraph to select at ${height}px: ${picked.ok ? "" : picked.why}`).toBe(
      true,
    );
    if (!picked.ok) continue;
    await page.waitForSelector(PANEL, { timeout: 5000 });
    await page.waitForTimeout(400);

    for (const step of ["closed", "open"] as const) {
      if (step === "open") {
        await page.getByRole("button", { name: "记笔记" }).click();
        await page.waitForTimeout(400);
      }
      const box = await page.evaluate(panelBox);
      expect(box, `${height}px ${step}: the panel must be mounted`).not.toBeNull();
      if (!box) continue;
      const where = `${height}px ${step}: panel ${box.top}..${box.bottom}, area ${picked.areaTop}..${picked.areaBottom}, words ${picked.selTop}..${picked.selBottom}`;
      // On the page. The panel keeps a 12px clearance inside the area, but
      // pinning that exact figure here would pin `EDGE` twice.
      expect(box.top, `${where} — must not rise past the top`).toBeGreaterThanOrEqual(
        picked.areaTop,
      );
      expect(box.bottom, `${where} — must not hang past the foot`).toBeLessThanOrEqual(
        picked.areaBottom,
      );
      // And clear of the passage: the panel goes below the words or above them,
      // never across them — but only where that is possible. On a page too
      // short to hold the panel clear of the selection there is no placement
      // that satisfies both, and staying on the page is the one that matters
      // (at a 420px window the area is 252px tall and the open panel is 186px,
      // which leaves 150px above the words and 81px below: neither fits). The
      // cases with room are the ones held to it, and they are the ones the old
      // placement failed.
      const panelHeight = box.bottom - box.top;
      const room = Math.max(picked.selTop - picked.areaTop, picked.areaBottom - picked.selBottom);
      if (room >= panelHeight) {
        expect(
          box.bottom <= picked.selTop || box.top >= picked.selBottom,
          `${where} — must not cover the words`,
        ).toBe(true);
      }
    }

    await page.getByRole("button", { name: "关闭" }).click();
    await page.waitForTimeout(300);
  }
});

test("a press on the panel's own controls does not count as leaving it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openBook(page);

  await page.locator(MARK).first().click();
  await page.waitForSelector(PANEL, { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "记笔记" }).click();
  await page.waitForTimeout(400);

  const field = page.getByRole("textbox", { name: "笔记" });
  await field.fill("写到一半换个颜色");

  // An ink swatch: a control with nothing to do with the note. In WebKit this
  // used to commit the note and close the whole toolbar.
  await page.getByRole("button", { name: "黄色" }).click();
  await page.waitForTimeout(500);
  await expect(page.locator(PANEL), "the panel must survive its own control").toHaveCount(1);
  await expect(field, "and keep the draft").toHaveValue("写到一半换个颜色");

  // The buttons this row exists for must still be reachable after the press —
  // they were unmounted mid-click before, which is what made them dead.
  await expect(page.getByRole("button", { name: "保存笔记" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "清空输入" })).toBeEnabled();
});

test("清空 empties the field only, and 删除 drops the note but not the highlight", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openBook(page);

  const openField = async () => {
    await page.locator(MARK).first().click();
    await page.waitForSelector(PANEL, { timeout: 5000 });
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "记笔记" }).click();
    await page.waitForTimeout(400);
  };

  await openField();
  const field = page.getByRole("textbox", { name: "笔记" });
  // Pre-filled from the highlight's own note, and 保存 is dead until something
  // changes — a save button that is always live invites a pointless write.
  await expect(field).not.toHaveValue("");
  const saved = await field.inputValue();
  await expect(page.getByRole("button", { name: "保存笔记" })).toBeDisabled();

  // 清空 touches the field and nothing else. Escape closes the field without
  // committing (closing the *panel* does commit — that is its rule), so what
  // the next open shows is the note as it still stands in the store.
  await page.getByRole("button", { name: "清空输入" }).click();
  await expect(field).toHaveValue("");
  await expect(page.getByRole("button", { name: "清空输入" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "关闭" }).click();
  await page.waitForTimeout(500);

  await openField();
  await expect(
    page.getByRole("textbox", { name: "笔记" }),
    "清空 must not have written",
  ).toHaveValue(saved);

  // 删除 drops the note and leaves the highlight standing. The write closes the
  // toolbar — `noteOnSelection` clears the pending selection once the note is
  // in — so wait for it to go rather than measure mid-exit.
  const marks = await page.locator(MARK).count();
  await page.getByRole("button", { name: "删除笔记" }).click();
  await page.waitForSelector(PANEL, { state: "detached", timeout: 5000 });
  await page.waitForTimeout(900);
  expect(await page.locator(MARK).count(), "the highlight stays").toBe(marks);

  await openField();
  await expect(page.getByRole("textbox", { name: "笔记" })).toHaveValue("");
  // Nothing left to drop, so the button is not offered: one that is always
  // there and sometimes does nothing is worse than one that appears when it
  // applies.
  await expect(page.getByRole("button", { name: "删除笔记" })).toHaveCount(0);
});
