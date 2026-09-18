import type { BookQuery, LibrarySort } from "@/types/ipc";

/**
 * The four shelves, which are one page with a filter rather than four routes:
 * the chrome is identical, so a route change would remount the whole grid for
 * a heading.
 *
 * `tags` is a shelf of its own because it carries a second selection (which
 * tag), which no other filter has.
 */
export type LibraryFilter = "all" | "recent" | "favorites" | "tags";

/**
 * Build the `BookQuery` the shelf reads.
 *
 * The `recent` filter used to force `sort: recentlyRead` here, which made the
 * sort dropdown a fake control on the shelf — readers who opened the menu
 * and picked, say, "文件大小" would see no change. The store's default is
 * still `recentlyRead`, so the shelf is unchanged for readers who never open
 * the dropdown; everyone else gets the sort they asked for.
 */
export function buildBookQuery(
  filter: LibraryFilter,
  sort: LibrarySort,
  search: string,
  tag: string | null,
): BookQuery {
  return {
    filter: filter === "recent" || filter === "favorites" ? filter : "all",
    sort,
    search: search.trim() || undefined,
    tag: filter === "tags" ? (tag ?? undefined) : undefined,
  };
}

/** Time-of-day lead on the shelf heading. */
export function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}
