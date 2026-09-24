import { describe, expect, it } from "vitest";

import { decodeText, detectFormat, splitChapters } from "@/lib/local/import";

/** The formats the shelf accepts, by extension. */
describe("detectFormat", () => {
  it("knows every extension the library lists", () => {
    for (const [name, format] of [
      ["book.epub", "epub"],
      ["book.PDF", "pdf"],
      ["book.mobi", "mobi"],
      ["book.azw3", "azw3"],
      ["book.fb2.zip", null],
      ["book.cbz", "cbz"],
      ["book.md", "markdown"],
      ["book.txt", "txt"],
    ] as const) {
      expect(detectFormat(name), name).toBe(format);
    }
  });
});

describe("decodeText", () => {
  it("reads UTF-8 as it is", () => {
    const bytes = new TextEncoder().encode("第一章 测试");
    expect(decodeText(bytes.buffer as ArrayBuffer)).toBe("第一章 测试");
  });

  it("falls back to GB18030 when UTF-8 comes out broken", () => {
    // 中文 .txt 书常见 GBK 编码：当作 UTF-8 读会得到一页替换字符。
    const bytes = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);
    expect(decodeText(bytes.buffer)).toBe("第一章");
  });
});

describe("splitChapters", () => {
  it("cuts at headings", () => {
    const text = ["第一章 起点", "正文一", "", "第二章 转折", "正文二"].join("\n");
    const chapters = splitChapters(text, "无名书");
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一章 起点", "第二章 转折"]);
    expect(chapters[0]!.paragraphs).toEqual(["正文一"]);
    expect(chapters[1]!.idx).toBe(1);
  });

  it("keeps text before the first heading under the book's own name", () => {
    const chapters = splitChapters("写在前面的话\n第一章 起点\n正文", "无名书");
    expect(chapters[0]).toEqual({
      idx: 0,
      title: "无名书",
      paragraphs: ["写在前面的话"],
    });
  });

  it("still splits a book with no headings at all", () => {
    // 没有标题的书也得有章节可分，否则目录和进度都无处落脚。
    const body = `${"一".repeat(9000)}\n\n${"二".repeat(9000)}`;
    const chapters = splitChapters(body, "无名书");
    expect(chapters.length).toBeGreaterThan(1);
    expect(chapters[1]!.title).toContain("无名书");
  });

  it("never returns an empty book", () => {
    const chapters = splitChapters("", "空书");
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.paragraphs).toHaveLength(1);
  });
});
