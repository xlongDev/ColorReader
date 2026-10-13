/** Where the reader put a bookmark: a chapter, and the fraction of it. */

import type { Bookmark } from "@/lib/bindings";
import * as db from "@/lib/local/db";
import { newId, now } from "./rows";

export async function bookmarkList(bookId: string): Promise<Bookmark[]> {
  const rows = await db.all<Bookmark>("bookmarks");
  return rows
    .filter((row) => row.bookId === bookId)
    .toSorted((a, b) => a.chapterIdx - b.chapterIdx || (a.fraction ?? 0) - (b.fraction ?? 0));
}

export async function bookmarkCreate(
  bookId: string,
  chapterIdx: number,
  fraction: number | null,
  label: string,
): Promise<Bookmark> {
  const bookmark: Bookmark = {
    id: newId(),
    bookId,
    chapterIdx,
    fraction,
    label,
    createdAt: now(),
  };
  await db.put("bookmarks", bookmark.id, bookmark);
  return bookmark;
}

export async function bookmarkDelete(id: string): Promise<void> {
  await db.del("bookmarks", id);
}
