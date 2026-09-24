import { describe, expect, it } from "vitest";

import { chapterFromBlocks, countChars, pdfLines, textBlocks } from "@/lib/local/blocks";

/** Parses a fragment the way foliate hands a section over: a whole document. */
const doc = (html: string): Element =>
  new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html").body;

describe("textBlocks", () => {
  it("reads prose in order and skips what is not prose", () => {
    const blocks = textBlocks(
      doc("<style>.x{}</style><script>var x=1</script><p>第一段</p><p>第二段</p>"),
    );
    expect(blocks).toEqual([
      { text: "第一段", heading: false },
      { text: "第二段", heading: false },
    ]);
  });

  it("marks a heading so the chapter can take its title from it", () => {
    const blocks = textBlocks(doc("<h2>第一章</h2><p>正文</p>"));
    expect(blocks).toEqual([
      { text: "第一章", heading: true },
      { text: "正文", heading: false },
    ]);
  });

  it("keeps a container's own text where it sits among its blocks", () => {
    // The text between children is a paragraph of its own; dropping it would
    // lose the opening line of plenty of hand-made books.
    const blocks = textBlocks(doc("<div>开头<p>中间</p>结尾</div>"));
    expect(blocks.map((block) => block.text)).toEqual(["开头", "中间", "结尾"]);
  });

  it("does not merge the paragraphs of a nested container", () => {
    const blocks = textBlocks(doc("<div><p>一</p><p>二</p></div>"));
    expect(blocks.map((block) => block.text)).toEqual(["一", "二"]);
  });

  it("keeps inline text with the paragraph it belongs to", () => {
    const blocks = textBlocks(doc("<p>前 <em>强调</em> 后</p>"));
    expect(blocks).toEqual([{ text: "前 强调 后", heading: false }]);
  });

  it("collapses whitespace the way the desktop does", () => {
    const blocks = textBlocks(doc("<p>  一\n\n  二\t三  </p>"));
    expect(blocks).toEqual([{ text: "一 二 三", heading: false }]);
  });

  it("emits nothing for a document with no prose", () => {
    // A pure-SVG cover is a spine entry with no text; it must not become a
    // chapter that reads as a blank page.
    expect(textBlocks(doc("<svg><text>x</text></svg><div></div>"))).toEqual([]);
  });

  it("treats a list item as a paragraph", () => {
    expect(textBlocks(doc("<ul><li>甲</li><li>乙</li></ul>")).map((b) => b.text)).toEqual([
      "甲",
      "乙",
    ]);
  });
});

/** One run of text at a baseline, the shape pdf.js reports. */
const run = (str: string, y: number, extra: Record<string, unknown> = {}) => ({
  str,
  transform: [10, 0, 0, 10, 40, y],
  height: 10,
  ...extra,
});

describe("pdfLines", () => {
  it("joins the runs that share a baseline into one line", () => {
    expect(pdfLines([run("The ", 700), run("page ", 700), run("is drawn.", 700)])).toEqual([
      "The page is drawn.",
    ]);
  });

  it("breaks where the baseline moves, even without a marker", () => {
    // Plenty of files emit no `hasEOL` at all; the geometry is then the only
    // thing saying where a line stops.
    expect(pdfLines([run("第一行", 700), run("第二行", 688)])).toEqual(["第一行", "第二行"]);
  });

  it("breaks on the document's own end-of-line marker", () => {
    expect(pdfLines([run("第一行", 700, { hasEOL: true }), run("第二行", 700)])).toEqual([
      "第一行",
      "第二行",
    ]);
  });

  it("ignores marked content, which carries no text", () => {
    expect(pdfLines([{ type: "beginMarkedContent" }, run("正文", 700)])).toEqual(["正文"]);
  });

  it("keeps a blank page blank rather than inventing a line", () => {
    expect(pdfLines([])).toEqual([]);
    expect(pdfLines([run("   ", 700)])).toEqual([]);
  });

  it("does not split a line when the run's own height is unknown", () => {
    // Without a height there is no scale to compare the move against, so the
    // marker is the only signal left.
    expect(
      pdfLines([
        { str: "a", transform: [1, 0, 0, 1, 0, 100] },
        { str: "b", transform: [1, 0, 0, 1, 0, 90] },
      ]),
    ).toEqual(["ab"]);
  });
});

describe("chapterFromBlocks", () => {
  it("titles the chapter with its first heading, which stays a paragraph", () => {
    const chapter = chapterFromBlocks(
      [
        { text: "第一章 起", heading: true },
        { text: "正文", heading: false },
        { text: "小标题", heading: true },
      ],
      "第 1 章",
    );
    expect(chapter.title).toBe("第一章 起");
    expect(chapter.paragraphs).toEqual(["第一章 起", "正文", "小标题"]);
  });

  it("falls back to a numbered title when the document has no heading", () => {
    const chapter = chapterFromBlocks([{ text: "正文", heading: false }], "第 3 章");
    expect(chapter.title).toBe("第 3 章");
  });

  it("counts the characters it was given", () => {
    expect(countChars(["ab", "cde"])).toBe(5);
  });
});
