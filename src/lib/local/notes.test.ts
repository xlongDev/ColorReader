import { describe, expect, it } from "vitest";

import {
  link,
  renderCsv,
  renderCsvMany,
  renderMarkdown,
  renderMarkdownMany,
  type NoteEntry,
  type Notes,
} from "@/lib/local/notes";

/**
 * The expectations below are the strings `src-tauri/src/library/export.rs`
 * asserts, copied over on purpose. The two implementations cannot share code —
 * the desktop's is on the other side of the IPC boundary, next to the *importer*
 * that reads this CSV back — so they are pinned to each other by their tests.
 * Change one side and the other goes red, which is the point.
 */

const entry = (
  id: string,
  chapterIdx: number,
  text: string,
  note: string | null = null,
): NoteEntry => ({ id, chapterIdx, text, note, color: null, style: null });

const notes = (entries: NoteEntry[]): Notes => ({
  id: "b1",
  title: "三体",
  authors: ["刘慈欣"],
  progress: 0.5,
  entries,
});

describe("renderMarkdown", () => {
  it("groups by chapter and puts notes under their quote", () => {
    expect(
      renderMarkdown(
        notes([
          entry("a1", 0, "你好", "第三章的伏笔"),
          entry("a2", 0, "再见"),
          entry("a3", 2, "最后一段", "记一笔"),
        ]),
      ),
    ).toBe(
      "# 《三体》标注与笔记\n" +
        "\n" +
        "刘慈欣 · 3 条标注 · 2 条有笔记 · 阅读进度 50%\n" +
        "\n" +
        "## 第 1 章\n" +
        "\n" +
        "> 你好\n" +
        "\n" +
        "第三章的伏笔\n" +
        "\n" +
        "[在 ColorReader 中打开](colorreader://book/b1?annotation=a1)\n" +
        "\n" +
        "> 再见\n" +
        "\n" +
        "[在 ColorReader 中打开](colorreader://book/b1?annotation=a2)\n" +
        "\n" +
        "## 第 3 章\n" +
        "\n" +
        "> 最后一段\n" +
        "\n" +
        "记一笔\n" +
        "\n" +
        "[在 ColorReader 中打开](colorreader://book/b1?annotation=a3)\n",
    );
  });

  it("keeps a multiline quote a single block", () => {
    const rendered = renderMarkdown(notes([entry("a1", 0, "第一行\n第二行")]));
    expect(rendered).toContain("> 第一行\n> 第二行");
  });

  it("says so when there is nothing to export", () => {
    const rendered = renderMarkdown(notes([]));
    expect(rendered).toContain("这本书还没有标注。");
    expect(rendered).toContain("0 条标注");
  });

  it("keeps the summary line clean for a book without an author", () => {
    const rendered = renderMarkdown({ ...notes([entry("a1", 0, "你好")]), authors: [] });
    expect(rendered).toContain("\n1 条标注 · 阅读进度 50%\n");
  });
});

describe("renderMarkdownMany", () => {
  it("gives each book a section one level above its chapters", () => {
    const rendered = renderMarkdownMany([notes([entry("a1", 0, "你好")])]);
    expect(rendered.startsWith("# 笔记导出\n")).toBe(true);
    expect(rendered).toContain("1 本书 · 1 条标注");
    expect(rendered).toContain("## 《三体》");
    expect(rendered).toContain("### 第 1 章");
  });
});

describe("the link format", () => {
  it("is the one the frontend parses", () => {
    // The other end of this contract is `parseDeepLink`, and the desktop pins
    // the same string in `export.rs`.
    expect(link("book-1", "note-1")).toBe("colorreader://book/book-1?annotation=note-1");
  });
});

describe("renderCsv", () => {
  it("is one row per highlight, with a byte-order mark", () => {
    expect(renderCsv(notes([entry("a1", 0, "你好", "伏笔")]))).toBe(
      "\uFEFF书名,章节,原文,笔记,颜色,样式,链接\n" +
        "三体,1,你好,伏笔,,,colorreader://book/b1?annotation=a1\n",
    );
  });

  it("escapes a field that holds a delimiter, a quote or a line break", () => {
    const rendered = renderCsv(notes([entry("a1", 0, '他说，"a,b"\n第二行')]));
    // Split on the delimiters *outside* quotes: three fields, not six.
    expect(rendered).toContain('"他说，""a,b""\n第二行"');
  });

  it("leads with the book title even for one book, because the importer needs it", () => {
    const rendered = renderCsv(notes([entry("a1", 0, "你好")]));
    expect(rendered.split("\n")[1]?.startsWith("三体,")).toBe(true);
  });
});

describe("renderCsvMany", () => {
  it("writes one header and every book's rows under it", () => {
    const rendered = renderCsvMany([
      notes([entry("a1", 0, "你好")]),
      { ...notes([entry("b1", 1, "再见")]), id: "b2", title: "流浪地球" },
    ]);
    const lines = rendered.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("\uFEFF书名,章节,原文,笔记,颜色,样式,链接");
    expect(lines[1]?.startsWith("三体,")).toBe(true);
    expect(lines[2]?.startsWith("流浪地球,")).toBe(true);
  });
});
