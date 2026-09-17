import { describe, expect, it } from "vitest";

import { buildStyleSheet, type FoliateStyle } from "./foliateStyle";
import { LONE_FIGURE_ATTR } from "./loneFigure";

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
  fontFaces: "",
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

  it("pins the colour scheme to normal in both palettes", () => {
    // A book that declares `:root { color-scheme: light dark }` makes WebKit
    // paint the section canvas opaque on a dark-mode OS; the page goes black on
    // a read that is not in night mode. The scheme has to be reclaimed even on
    // a light page, which is exactly where the symptom shows.
    expect(buildStyleSheet(style())).toContain("color-scheme: normal !important");
    expect(buildStyleSheet(style({ dark: false }))).toContain("color-scheme: normal !important");
  });

  it("drops the baseline descent under a picture that owns its line", () => {
    // The paginator sizes a figure to the whole column (setImageSize). An
    // inline picture sits on a baseline, so its line box also carries the
    // strut's descent below it — taller than the page, and the residue spills
    // into a column with nothing visible in it, which the reader shows as a
    // blank page (measured: 3 columns for a 1-page cover).
    const css = buildStyleSheet(style({ dark: false }));
    expect(css).toContain("vertical-align: bottom !important");
    // Scoped to the marked figures: the same declaration would sink an icon
    // that shares a line with text, and the mark is what tells them apart.
    expect(css).toContain(`[${LONE_FIGURE_ATTR}]`);
  });

  it("lets an SVG keep its own proportions instead of the page's", () => {
    // A Calibre cover is `width="100%" height="100%" preserveAspectRatio="none"`
    // and the paginator caps only the height, so the artwork is stretched into
    // whatever shape the page is (measured: a 950x1388 cover painted 720x427).
    expect(buildStyleSheet(style({ dark: false }))).toContain("svg[viewBox]");
  });

  it("caps replaced elements the paginator would let overflow the column", () => {
    expect(buildStyleSheet(style({ dark: false }))).toContain("max-width: 100% !important");
  });

  it("keeps the paragraph gap off the book's own layout boxes", () => {
    const css = buildStyleSheet(style({ dark: false }));
    // An empty div, or one wrapping a picture, is not a paragraph: the gap
    // lands in front of a full-column figure and pushes it into the next
    // column, leaving the page it came from blank.
    expect(css).toContain("div:not(:empty)");
    expect(css).toContain("> img, > svg");
  });

  it("carries the imported faces into the section, which is its own document", () => {
    // A book section is a document: the app's own @font-face never reaches it,
    // so the sheet has to bring the declaration along with the family name.
    const css = buildStyleSheet(style({ fontFaces: '@font-face { font-family: "cr-1" }' }));
    expect(css).toContain('@font-face { font-family: "cr-1" }');
  });

  it("inverts a book's pictures only when asked, and only on a night page", () => {
    expect(buildStyleSheet(style())).not.toContain("invert(1)");
    expect(buildStyleSheet(style({ dark: false, invertImages: true }))).not.toContain("invert(1)");
    expect(buildStyleSheet(style({ invertImages: true }))).toContain(
      "filter: invert(1) hue-rotate(180deg)",
    );
  });
});
