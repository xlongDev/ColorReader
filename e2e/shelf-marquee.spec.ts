import { expect, test } from "@playwright/test";

/**
 * A long author name slides out from under the mask on hover.
 *
 * This is the one shelf behaviour that has no other symptom: `MarqueeText`
 * measures its own overflow and only then decides to scroll, so a component
 * that never measures looks exactly like a name that happens to fit — an
 * ellipsis, and nothing else. It shipped that way once. The first version
 * returned a bare `<span className="truncate">` while the overflow was zero
 * and attached the measuring refs only on the scrolling branch, which meant
 * the refs were never attached and the overflow could never leave zero.
 *
 * So the assertions are, in order: the fixture really is a long name in a
 * narrow slot (or the rest proves nothing), the component noticed, and the
 * name actually moves. The last one is the only one the dead version could not
 * have satisfied.
 *
 * `prefers-reduced-motion` turns the slide off by design, and Playwright's
 * default is `no-preference`, so the slide is expected here.
 */
test("a long author name marquees on hover instead of staying truncated", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  const slot = page.locator("[data-marquee]").first();
  await expect(slot).toBeVisible();

  const measured = await slot.evaluate((el) => {
    const inner = el.firstElementChild as HTMLElement;
    return {
      slot: el.clientWidth,
      content: inner.scrollWidth,
      innerClass: inner.className,
      inline: el.getAttribute("style") ?? "",
    };
  });
  expect(
    measured.content,
    `the fixture has to overflow for this to mean anything (slot ${measured.slot}px, content ${measured.content}px)`,
  ).toBeGreaterThan(measured.slot + 8);
  // `truncate` while it fits, `w-max` once it scrolls — the two branches.
  expect(measured.innerClass).toContain("w-max");
  expect(measured.inline).toContain("mask-image");

  // `whileHover` is on the inner span, so the pointer goes to the text itself.
  await slot.hover();
  const travelled = await page.evaluate(async () => {
    const inner = document.querySelector("[data-marquee]")!.firstElementChild as HTMLElement;
    // Bounded by the clock, not by a frame count: the slide is 1.5s of
    // animation, and a frame is not a unit of time — WebKit's headless rAF runs
    // at its own rate, so a fixed number of frames covered barely a second of
    // it and the assertion landed on the threshold rather than past it.
    const deadline = performance.now() + 3000;
    let least = 0;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const match = /matrix\(([^)]+)\)/.exec(getComputedStyle(inner).transform);
      if (match) least = Math.min(least, Number((match[1] ?? "").split(",")[4] ?? 0));
      if (least < -20) break;
    }
    return Math.round(least);
  });
  expect(travelled, "the name has to slide out from under the mask").toBeLessThan(-20);
});
