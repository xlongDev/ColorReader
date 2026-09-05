import { describe, expect, it } from "vitest";

import { parseSnippet } from "./snippet";
import { MARK_END, MARK_START } from "@/types/ipc";

describe("parseSnippet", () => {
  it("splits the text around the marked run", () => {
    expect(parseSnippet(`前面${MARK_START}命中${MARK_END}后面`)).toEqual([
      { text: "前面", matched: false },
      { text: "命中", matched: true },
      { text: "后面", matched: false },
    ]);
  });

  it("keeps unmarked text as a single part", () => {
    expect(parseSnippet("没有标记")).toEqual([{ text: "没有标记", matched: false }]);
  });

  it("returns nothing for an empty snippet", () => {
    expect(parseSnippet("")).toEqual([]);
  });

  it("falls back to plain text when a marker is never closed", () => {
    // The backend always emits both markers; malformed input must still render.
    const malformed = `abc${MARK_START}def`;
    expect(parseSnippet(malformed)).toEqual([{ text: malformed, matched: false }]);
  });
});
