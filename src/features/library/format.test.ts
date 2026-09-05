import { describe, expect, it } from "vitest";

import { formatFileSize, sortOptions, titleForFilter } from "@/features/library/format";

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
