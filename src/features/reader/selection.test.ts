import { describe, expect, it } from "vitest";

import {
  charRange,
  highlightSegments,
  joinedText,
  matchRanges,
  paragraphAt,
  paragraphStart,
  segmentText,
} from "./selection";
import type { Annotation } from "@/types/ipc";

const paragraphs = ["你好世界", "abc", "🎉x"]; // 4 + 3 + 3 chars → joined "你好世界\nabc\n🎉x"

function annotation(chapterIdx: number, startChar: number, endChar: number): Annotation {
  return {
    id: "a",
    bookId: "b",
    chapterIdx,
    startChar,
    endChar,
    text: "",
    createdAt: 0,
  };
}

describe("joinedText / paragraphStart", () => {
  it("joins with newlines and sums preceding lengths plus separators", () => {
    expect(joinedText(paragraphs)).toBe("你好世界\nabc\n🎉x");
    expect(paragraphStart(paragraphs, 0)).toBe(0);
    expect(paragraphStart(paragraphs, 1)).toBe(5);
    expect(paragraphStart(paragraphs, 2)).toBe(9);
  });
});

describe("charRange", () => {
  it("maps paragraph-local positions onto the joined text", () => {
    expect(charRange(paragraphs, 1, 0, 1, 3)).toEqual({ start: 5, end: 8, text: "abc" });
  });

  it("spans paragraphs and keeps the newline separator", () => {
    // End of para 0 through "ab" of para 1.
    expect(charRange(paragraphs, 0, 2, 1, 2)).toEqual({
      start: 2,
      end: 7,
      text: "世界\nab",
    });
  });

  it("counts a surrogate pair as two UTF-16 units", () => {
    // "🎉" is length 2 in UTF-16.
    expect(charRange(paragraphs, 2, 0, 2, 2)).toEqual({ start: 9, end: 11, text: "🎉" });
  });

  it("rejects empty and inverted ranges", () => {
    expect(charRange(paragraphs, 0, 1, 0, 1)).toBeNull();
    expect(charRange(paragraphs, 1, 3, 1, 0)).toBeNull();
  });
});

describe("segmentText", () => {
  it("splits a paragraph around a single range", () => {
    expect(segmentText("你好世界", [[1, 3]])).toEqual([
      { text: "你", highlighted: false },
      { text: "好世", highlighted: true },
      { text: "界", highlighted: false },
    ]);
  });

  it("returns the whole text untouched without ranges", () => {
    expect(segmentText("abc", [])).toEqual([{ text: "abc", highlighted: false }]);
    expect(segmentText("", [[0, 1]])).toEqual([]);
  });

  it("clamps a range that bleeds past the text", () => {
    expect(segmentText("abc", [[5, 12]])).toEqual([{ text: "abc", highlighted: false }]);
  });

  it("keeps two touching ranges from merging", () => {
    expect(
      segmentText("abcd", [
        [0, 2],
        [2, 4],
      ]),
    ).toEqual([
      { text: "ab", highlighted: true },
      { text: "cd", highlighted: true },
    ]);
  });
});

describe("highlightSegments", () => {
  it("marks the part of the paragraph an annotation covers", () => {
    const segments = highlightSegments(paragraphs, 0, [annotation(0, 1, 3)], "");
    expect(segments).toEqual([
      { text: "你", highlighted: false },
      { text: "好世", highlighted: true },
      { text: "界", highlighted: false },
    ]);
  });

  it("covers a whole paragraph when the highlight runs into the next one", () => {
    const segments = highlightSegments(paragraphs, 1, [annotation(0, 5, 12)], "");
    expect(segments).toEqual([{ text: "abc", highlighted: true }]);
  });

  it("marks every occurrence of the search query", () => {
    const segments = highlightSegments(["aXbXc"], 0, [], "x");
    expect(segments).toEqual([
      { text: "a", highlighted: false },
      { text: "X", highlighted: true },
      { text: "b", highlighted: false },
      { text: "X", highlighted: true },
      { text: "c", highlighted: false },
    ]);
  });

  it("keeps annotations and query matches together", () => {
    const segments = highlightSegments(paragraphs, 1, [annotation(0, 5, 6)], "c");
    expect(segments).toEqual([
      { text: "a", highlighted: true },
      { text: "b", highlighted: false },
      { text: "c", highlighted: true },
    ]);
  });
});

describe("matchRanges", () => {
  it("finds overlapping-free occurrences and ignores case", () => {
    expect(matchRanges("Rust in rust", "rust")).toEqual([
      [0, 4],
      [8, 12],
    ]);
  });

  it("returns nothing for a blank query", () => {
    expect(matchRanges("anything", "  ")).toEqual([]);
  });
});

describe("paragraphAt", () => {
  it("locates the paragraph holding an offset of the joined text", () => {
    expect(paragraphAt(paragraphs, 0)).toBe(0);
    expect(paragraphAt(paragraphs, 4)).toBe(0);
    expect(paragraphAt(paragraphs, 5)).toBe(1);
    expect(paragraphAt(paragraphs, 9)).toBe(2);
  });

  it("falls back to the last paragraph past the end", () => {
    expect(paragraphAt(paragraphs, 999)).toBe(2);
    expect(paragraphAt([], 0)).toBe(0);
  });
});
