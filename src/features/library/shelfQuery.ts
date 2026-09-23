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

/**
 * The label the 标签 shelf should actually filter by.
 *
 * A remembered label can be deleted while the shelf is away. Deleting it from
 * the bar clears the choice itself (`TagBar` calls `onSelect(null)`), but a
 * label removed from its last book somewhere else does not — and a filter
 * pointing at a label that no longer exists is an empty grid with no chip lit
 * to explain it, which reads as a broken shelf rather than as a filter. So an
 * unknown label falls back to the whole shelf.
 *
 * `undefined` means "the labels are not loaded yet", not "there are none":
 * dropping the choice then would forget it on every mount.
 */
export function resolveTagFilter(
  remembered: string | null,
  known: readonly { name: string }[] | undefined,
): string | null {
  if (remembered === null || known === undefined) return remembered;
  return known.some((entry) => entry.name === remembered) ? remembered : null;
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
