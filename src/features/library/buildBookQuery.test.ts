import { describe, expect, it } from "vitest";

import { buildBookQuery } from "@/features/library/shelfQuery";

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
