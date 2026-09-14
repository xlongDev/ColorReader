import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Markdown, parseBlocks, type ListItem } from "./Markdown";

/** List items as `parseBlocks` shapes them: position plus text. */
const items = (...texts: string[]): ListItem[] => texts.map((text, order) => ({ order, text }));

describe("parseBlocks", () => {
  it("splits headings, paragraphs and lists", () => {
    const blocks = parseBlocks("## 一句话概括\n这本书讲了一件事。\n\n- 第一条\n- 第二条\n");
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "一句话概括" },
      { kind: "paragraph", text: "这本书讲了一件事。" },
      { kind: "list", ordered: false, items: items("第一条", "第二条") },
    ]);
  });

  it("joins wrapped lines into one paragraph", () => {
    expect(parseBlocks("上半句\n下半句")).toEqual([{ kind: "paragraph", text: "上半句 下半句" }]);
  });

  it("starts a new list when the marker changes", () => {
    expect(parseBlocks("- 一\n1. 二")).toEqual([
      { kind: "list", ordered: false, items: items("一") },
      { kind: "list", ordered: true, items: items("二") },
    ]);
  });

  it("reads block quotes", () => {
    expect(parseBlocks("> 引用")).toEqual([{ kind: "quote", text: "引用" }]);
  });

  it("keeps a half-written marker literal while the answer streams", () => {
    // The streaming case: `**关键` has no closing marker yet, so it must render
    // as text rather than swallowing everything after it.
    expect(parseBlocks("**关键")).toEqual([{ kind: "paragraph", text: "**关键" }]);
    expect(parseBlocks("- 第一条\n- 第二")).toEqual([
      { kind: "list", ordered: false, items: items("第一条", "第二") },
    ]);
    expect(parseBlocks("")).toEqual([]);
  });
});

describe("Markdown", () => {
  it("renders emphasis and code as elements", () => {
    render(<Markdown text={"**粗** 与 `码`"} />);
    expect(screen.getByText("粗").tagName).toBe("STRONG");
    expect(screen.getByText("码").tagName).toBe("CODE");
  });

  it("never turns model output into markup", () => {
    render(<Markdown text={'<img src="x" onerror="alert(1)">'} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
