/**
 * Highlights: one per marked range of one chapter, with the ink, the note and
 * (where the renderer can say) the CFI that anchors it to the text.
 *
 * Deleting counts the way the desktop counts — a selection is a snapshot, and a
 * highlight deleted in the reader between the click and the call is not there
 * to delete.
 */

import type { Annotation } from "@/lib/bindings";
import * as db from "@/lib/local/db";
import { newId, now } from "./rows";

export async function annotationList(bookId: string): Promise<Annotation[]> {
  const rows = await db.all<Annotation>("annotations");
  return rows
    .filter((row) => row.bookId === bookId)
    .toSorted((a, b) => a.chapterIdx - b.chapterIdx || a.startChar - b.startChar);
}

export async function annotationCreate(
  bookId: string,
  chapterIdx: number,
  startChar: number,
  endChar: number,
  text: string,
  cfi: string | null,
  color: string | null,
  style: string | null,
): Promise<Annotation> {
  const annotation: Annotation = {
    id: newId(),
    bookId,
    chapterIdx,
    startChar,
    endChar,
    text,
    cfi,
    color,
    style,
    note: null,
    createdAt: now(),
  };
  await db.put("annotations", annotation.id, annotation);
  return annotation;
}

export async function annotationDelete(id: string): Promise<null> {
  await db.del("annotations", id);
  return null;
}

/** How many rows actually went, counted the way the desktop counts them: a
 *  selection is a snapshot, and a highlight deleted in the reader between the
 *  click and this call is not there to delete. */
export async function annotationDeleteMany(ids: string[]): Promise<number> {
  const existing = new Set(await db.keys("annotations"));
  const gone = ids.filter((id) => existing.has(id)).length;
  await Promise.all(ids.map((id) => db.del("annotations", id)));
  return gone;
}

/** The mutable half of a highlight: ink and how it paints. Answers the row it
 *  wrote, which is what the caller patches its cache with. */
async function annotationPatch(id: string, patch: Partial<Annotation>): Promise<Annotation> {
  const row = await db.get<Annotation>("annotations", id);
  if (!row) throw new Error("这条标注已经不存在了");
  const next = { ...row, ...patch };
  await db.put("annotations", id, next);
  return next;
}

export async function annotationUpdate(
  id: string,
  color: string | null,
  style: string | null,
): Promise<Annotation> {
  return annotationPatch(id, { color, style });
}

export async function annotationAnchor(id: string, cfi: string): Promise<Annotation> {
  return annotationPatch(id, { cfi });
}

export async function annotationNote(id: string, note: string | null): Promise<Annotation> {
  return annotationPatch(id, { note: note?.trim() ? note : null });
}
