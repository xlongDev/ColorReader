import { describe, expect, it } from "vitest";
import type { BookSummary } from "@/types/ipc";

import {
  formatFileSize,
  pickContinueReading,
  sortOptions,
  titleForFilter,
} from "@/features/library/format";

function makeBook(overrides: Partial<BookSummary>): BookSummary {
  return {
    id: "x",
    title: "测试书",
    subtitle: null,
    description: null,
    language: "zh",
    publisher: null,
    format: "epub",
    fileSize: 0,
    coverUrl: null,
    addedAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    progress: null,
    location: null,
    favorite: false,
    authors: [],
    tags: [],
    ...overrides,
  } as BookSummary;
}

describe("formatFileSize", () => {
  it("uses bytes below one kilobyte", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("uses kilobytes and megabytes", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536 * 1024)).toBe("1.5 MB");
  });

  it("survives unknown sizes", () => {
    expect(formatFileSize(-1)).toBe("");
  });
});

describe("titleForFilter", () => {
  it("gives each shelf a title and subtitle", () => {
    const all = titleForFilter("all");
    expect(all.title).toBe("书库");
    expect(all.subtitle.length).toBeGreaterThan(0);
  });
});

describe("sortOptions", () => {
  it("has a stable value/label pairing", () => {
    expect(sortOptions.length).toBeGreaterThanOrEqual(3);
    for (const option of sortOptions) {
      expect(option.value.length).toBeGreaterThan(0);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});

describe("pickContinueReading", () => {
  it("returns undefined when nothing has been opened", () => {
    const list = [
      makeBook({ id: "a", lastReadAt: null, progress: 0.5 }),
      makeBook({ id: "b", lastReadAt: null, progress: 0.8 }),
    ];
    expect(pickContinueReading(list)).toBeUndefined();
  });

  it("picks the book with the most recent lastReadAt, regardless of progress", () => {
    // The shelf used to pick the *first* book with progress > 0, which
    // meant opening a brand-new book (progress=null) stopped the card from
    // pointing at the book actually opened last.
    const list = [
      makeBook({ id: "old", lastReadAt: 100, progress: 0.9 }),
      makeBook({ id: "latest", lastReadAt: 200, progress: 0.02 }),
      makeBook({ id: "middle", lastReadAt: 150, progress: 0.6 }),
    ];
    expect(pickContinueReading(list)?.id).toBe("latest");
  });

  it("ignores progress entirely — the most recently opened book wins", () => {
    const list = [
      makeBook({ id: "finished", lastReadAt: 100, progress: 1 }),
      makeBook({ id: "opened", lastReadAt: 200, progress: 0 }),
    ];
    expect(pickContinueReading(list)?.id).toBe("opened");
  });

  it("returns undefined for an empty shelf", () => {
    expect(pickContinueReading([])).toBeUndefined();
  });
});
