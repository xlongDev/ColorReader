import { describe, expect, it } from "vitest";

import { buildBookQuery, resolveTagFilter } from "@/features/library/shelfQuery";

describe("buildBookQuery", () => {
  it("forwards the sort unchanged on the `recent` filter", () => {
    // The whole point of the fix: the shelf's sort dropdown stops being a
    // fake control. Readers who open it and pick 文件大小 get the order they
    // asked for; readers who never touch it keep the store default.
    const picks = ["recentlyAdded", "titleAsc", "authorAsc", "formatAsc", "sizeDesc"] as const;
    for (const sort of picks) {
      expect(buildBookQuery("recent", sort, "", null).sort).toBe(sort);
    }
  });

  it("maps `all` to the all shelf and forwards sort", () => {
    expect(buildBookQuery("all", "titleAsc", "", null)).toEqual({
      filter: "all",
      sort: "titleAsc",
      search: undefined,
      tag: undefined,
    });
  });

  it("passes `recent` and `favorites` through as filter values", () => {
    expect(buildBookQuery("favorites", "recentlyRead", "", null).filter).toBe("favorites");
    expect(buildBookQuery("recent", "recentlyRead", "", null).filter).toBe("recent");
  });

  it("carries the active tag only on the tag shelf", () => {
    expect(buildBookQuery("tags", "recentlyRead", "", "历史").tag).toBe("历史");
    expect(buildBookQuery("all", "recentlyRead", "", "历史").tag).toBeUndefined();
  });

  it("trims the search and drops an empty one", () => {
    expect(buildBookQuery("all", "recentlyRead", "  马尔克斯  ", null).search).toBe("马尔克斯");
    expect(buildBookQuery("all", "recentlyRead", "   ", null).search).toBeUndefined();
  });
});

describe("resolveTagFilter", () => {
  const known = [{ name: "小说" }, { name: "悬疑" }];

  it("keeps a label that still exists", () => {
    expect(resolveTagFilter("小说", known)).toBe("小说");
  });

  it("falls back to the whole shelf when the remembered label is gone", () => {
    // The case `TagBar` cannot see: deleting from the bar clears the choice,
    // but a label removed from its last book elsewhere does not — and the
    // filter would then point at nothing.
    expect(resolveTagFilter("历史", known)).toBeNull();
    expect(resolveTagFilter("小说", [])).toBeNull();
  });

  it("keeps the choice while the labels are still loading", () => {
    // `undefined` is "not known yet", not "there are none". Treating them the
    // same would forget the choice on every mount.
    expect(resolveTagFilter("小说", undefined)).toBe("小说");
  });

  it("stays on the whole shelf when nothing was remembered", () => {
    expect(resolveTagFilter(null, known)).toBeNull();
    expect(resolveTagFilter(null, undefined)).toBeNull();
  });
});
