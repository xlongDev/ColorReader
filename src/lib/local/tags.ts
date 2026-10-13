/** Tags are names on book rows, counted across the shelf. */

import type { TagSummary } from "@/lib/bindings";
import * as db from "@/lib/local/db";
import { type StoredBook, bookRow, patchBook } from "./rows";

export async function tagList(): Promise<TagSummary[]> {
  const counts = new Map<string, number>();
  for (const book of await db.all<StoredBook>("books")) {
    for (const name of book.tags) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((a, b) => a[0].localeCompare(b[0], "zh"))
    .map(([name, count]) => ({ id: name, name, count }));
}

export async function bookSetTags(ids: string[], add: string[], remove: string[]): Promise<void> {
  const drop = new Set(remove.map((name) => name.toLowerCase()));
  await Promise.all(
    ids.map(async (id) => {
      const row = await bookRow(id);
      if (!row) return;
      const tags = row.tags.filter((name) => !drop.has(name.toLowerCase()));
      for (const name of add) {
        if (!tags.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
          tags.push(name);
        }
      }
      await patchBook(id, { tags });
    }),
  );
}

export async function tagDelete(id: string): Promise<void> {
  const lower = id.toLowerCase();
  const tagged = (await db.all<StoredBook>("books")).filter((book) =>
    book.tags.some((name) => name.toLowerCase() === lower),
  );
  await Promise.all(
    tagged.map((book) =>
      patchBook(book.id, { tags: book.tags.filter((name) => name.toLowerCase() !== lower) }),
    ),
  );
}
