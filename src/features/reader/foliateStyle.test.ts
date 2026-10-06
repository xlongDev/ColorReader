import { describe, expect, it } from "vitest";

import {
  applyVerticalQuotes,
  buildStyleSheet,
  verticalQuotes,
  type FoliateStyle,
} from "./foliateStyle";
import { LONE_FIGURE_ATTR } from "./loneFigure";

/** A night page, so each case only states the field it is about. */
const style = (over: Partial<FoliateStyle> = {}): FoliateStyle => ({
  fontSize: 18,
  fontFamily: "Songti SC, serif",
  lineHeight: 1.7,
  paraGap: 0.9,
  indent: true,
  bookTypography: false,
  fg: "#c9ced8",
  bg: "#181c23",
  dark: true,
  invertImages: false,
  fontFaces: "",
  writingMode: "auto",
  quoteReplace: false,
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

  /**
   * 使用书籍排版: the book designed its own line height, paragraph gap and
   * first-line indent — the sheet injects none of them, and the reader's
   * three settings stand down entirely. Font size is not part of the deal.
   */
  it("leaves the book's paragraph styles alone when 使用书籍排版 is on", () => {
    const css = buildStyleSheet(style({ bookTypography: true, dark: false }));
    expect(css).not.toContain("line-height:");
    expect(css).not.toContain("margin-top");
    expect(css).not.toContain("text-indent");
    // The reader always owns the body size, typography or not.
    expect(css).toContain("font-size: 18px !important");
  });

  it("forces the typeface unless the reader picked 原书字体", () => {
    // A real key wins over the book with !important — the KF8 books restate
    // the family on every paragraph class.
    expect(buildStyleSheet(style({ dark: false }))).toContain(
      "font-family: Songti SC, serif !important",
    );
    // 原书字体: no font-family anywhere; the book's faces stand.
    const book = buildStyleSheet(style({ fontFamily: null, dark: false }));
    expect(book).not.toContain("font-family:");
    expect(book).toContain("font-size: 18px !important");
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

  it("turns the text vertical only when asked, and can force it back horizontal", () => {
    // 跟随书籍 (auto) injects nothing: the book's own writing-mode stands.
    expect(buildStyleSheet(style())).not.toContain("writing-mode");
    // On the text elements, not only the root: a converted book restates
    // writing-mode on its own paragraph classes.
    expect(buildStyleSheet(style({ writingMode: "vertical" }))).toContain(
      "writing-mode: vertical-rl !important",
    );
    // 横排: a book that typesets itself vertical can be forced back.
    expect(buildStyleSheet(style({ writingMode: "horizontal" }))).toContain(
      "writing-mode: horizontal-tb !important",
    );
  });

  /**
   * 替换引号: the western curly quotes become the corner brackets vertical
   * CJK is set with (the Unicode vertical presentation forms of 「」『』).
   * Everything else — an apostrophe inside a word, a straight quote — passes
   * through untouched.
   */
  it("maps the four curly quotes to the vertical corner forms and nothing else", () => {
    expect(verticalQuotes("“引”和‘单’")).toBe("﹁引﹂和﹃单﹄");
    // The right single quote is an apostrophe in English text; it becomes the
    // vertical form too — readest does the same, and a vertical CJK page is
    // where this runs.
    expect(verticalQuotes("don’t")).toBe("don﹄t");
    expect(verticalQuotes("straight \" and ' stay")).toBe("straight \" and ' stay");
    expect(verticalQuotes("无引号")).toBe("无引号");
  });

  it("rewrites every text node of a section document, and only text nodes", () => {
    const doc = new DOMParser().parseFromString(
      `<article><p>他说：“你好。”</p><p>don’t stop</p><img alt="“不这里”"><style>.x::before{content:"“css 不动”"}</style></article>`,
      "text/html",
    );
    const changed = applyVerticalQuotes(doc);
    // Two text nodes changed: the two paragraphs. Attribute values (the img
    // alt), the style element's sheet text and code samples are skipped —
    // rewriting those would corrupt the rule, not the prose.
    expect(changed).toBe(2);
    expect(doc.body.textContent).toContain("他说：﹁你好。﹂");
    expect(doc.body.textContent).toContain("don﹄t stop");
    expect(doc.querySelector("style")?.textContent).toContain("“css 不动”");
  });
});
