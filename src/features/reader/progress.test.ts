import { describe, expect, it } from "vitest";

import {
  estimateLabel,
  globalProgress,
  locateChapter,
  remainingChars,
  totalChars,
} from "./progress";
import type { ChapterMeta } from "@/types/ipc";

const chapters: ChapterMeta[] = [
  { idx: 0, title: "甲", chars: 10 },
  { idx: 1, title: "乙", chars: 30 },
  { idx: 2, title: "丙", chars: 10 },
];

describe("totalChars", () => {
  it("sums chapter character counts", () => {
    expect(totalChars(chapters)).toBe(50);
    expect(totalChars([])).toBe(0);
  });
});

describe("locateChapter", () => {
  it("maps the very start to the first chapter", () => {
    expect(locateChapter(chapters, 0)).toEqual({ idx: 0, fraction: 0 });
  });

  it("falls at a chapter boundary on the next chapter", () => {
    // 10/50 = 0.2 is exactly the end of chapter 0.
    expect(locateChapter(chapters, 0.2)).toEqual({ idx: 1, fraction: 0 });
  });

  it("maps the middle onto the correct chapter and offset", () => {
    // 25/50 = 0.5 → 15 chars into chapter 1 (30 chars) = 0.5.
    expect(locateChapter(chapters, 0.5)).toEqual({ idx: 1, fraction: 0.5 });
  });

  it("clamps overshoot to the final chapter", () => {
    expect(locateChapter(chapters, 1)).toEqual({ idx: 2, fraction: 1 });
    expect(locateChapter(chapters, 1.5)).toEqual({ idx: 2, fraction: 1 });
  });

  it("handles an empty table gracefully", () => {
    expect(locateChapter([], 0.4)).toEqual({ idx: 0, fraction: 0 });
  });
});

describe("globalProgress", () => {
  it("is the inverse of locateChapter", () => {
    const located = locateChapter(chapters, 0.5);
    expect(globalProgress(chapters, located.idx, located.fraction)).toBeCloseTo(0.5);
  });

  it("reports 0 for the start and 1 for the end", () => {
    expect(globalProgress(chapters, 0, 0)).toBe(0);
    expect(globalProgress(chapters, 2, 1)).toBe(1);
  });
});

describe("remainingChars", () => {
  it("counts from the current position to the end of the book", () => {
    expect(remainingChars(chapters, 0, 0)).toBe(50);
    expect(remainingChars(chapters, 1, 0.5)).toBe(25);
    expect(remainingChars(chapters, 2, 1)).toBe(0);
  });

  it("never goes negative on an overshooting fraction", () => {
    expect(remainingChars(chapters, 2, 1.5)).toBe(0);
    expect(remainingChars([], 0, 0)).toBe(0);
  });
});

describe("estimateLabel", () => {
  it("labels sub-minute, minutes and hours", () => {
    expect(estimateLabel(100, 300)).toBe("不到 1 分钟");
    expect(estimateLabel(900, 300)).toBe("约 3 分钟");
    expect(estimateLabel(7200, 300)).toBe("约 24 分钟");
    expect(estimateLabel(36000, 300)).toBe("约 2 小时");
    expect(estimateLabel(37000, 300)).toBe("约 2 小时 3 分钟");
  });

  it("degrades gracefully on a zero speed", () => {
    expect(estimateLabel(100, 0)).toBe("未知");
  });
});
