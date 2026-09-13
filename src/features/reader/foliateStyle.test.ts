import { describe, expect, it } from "vitest";

import { buildStyleSheet, type FoliateStyle } from "./foliateStyle";

/** A night page, so each case only states the field it is about. */
const style = (over: Partial<FoliateStyle> = {}): FoliateStyle => ({
  fontSize: 18,
  fontFamily: "Songti SC, serif",
  lineHeight: 1.7,
  paraGap: 0.9,
  indent: true,
  fg: "#c9ced8",
  bg: "#181c23",
  dark: true,
  invertImages: false,
  ...over,
});

describe("buildStyleSheet", () => {
  it("hands the paginator the night palette and repaints the book's own text", () => {
    const css = buildStyleSheet(style());
    // The resolver reads these off the section's <html>; without them the page
    // keeps the book's own light paper.
    expect(css).toContain("--theme-bg-color: #181c23");
    expect(css).toContain("--override-color: true");
    // Element level, because a converted book restates colour on its own
    // classes and inline on spans — `html, body` alone never reaches them.
    expect(css).toContain("color: #c9ced8 !important");
  });

  it("leaves a light page on typography alone", () => {
    const css = buildStyleSheet(style({ dark: false }));
    expect(css).not.toContain("--theme-bg-color");
    expect(css).not.toContain("--override-color");
    expect(css).not.toContain("invert(1)");
  });

  it("caps replaced elements the paginator would let overflow the column", () => {
    expect(buildStyleSheet(style({ dark: false }))).toContain("max-width: 100% !important");
  });

  it("inverts a book's pictures only when asked, and only on a night page", () => {
    expect(buildStyleSheet(style())).not.toContain("invert(1)");
    expect(buildStyleSheet(style({ dark: false, invertImages: true }))).not.toContain("invert(1)");
    expect(buildStyleSheet(style({ invertImages: true }))).toContain(
      "filter: invert(1) hue-rotate(180deg)",
    );
  });
});
