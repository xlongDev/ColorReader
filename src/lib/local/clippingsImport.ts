/**
 * Reads a clippings file back into the library.
 *
 * The parse is `clippings.ts`; the write is this file's, and it is the one that
 * has to agree with the desktop's: a dry run reports exactly what a real run
 * would write, because the number on the dialog's confirm button has to be the
 * number the reader gets.
 */

import type { Annotation, BookOutcome, ChapterContent, Outcome } from "@/lib/bindings";
import { parseClippings } from "@/lib/local/clippings";
import * as db from "@/lib/local/db";
import { annotationCreate, annotationNote } from "./annotations";
import { type StoredBook } from "./rows";

/* -------------------------------------------------------------- clippings */

/**
 * Reads a clippings file back into the library.
 *
 * The desktop's reads the file off a path; here the reader hands us the file
 * itself, and the parse and the write are the same shape either way (see
 * `clippings.ts`). Only this app's own Markdown and CSV are understood — a
 * Kindle `My Clippings.txt` is refused outright rather than guessed at.
 *
 * A dry run reports exactly what a real run would write, which is the whole
 * point of the dialog's two steps: the number on its confirm button has to be
 * the number the reader gets.
 */
export async function clippingsImportFile(file: File, dryRun: boolean): Promise<Outcome> {
  const parsed = parseClippings(await file.text());
  if (!parsed) {
    throw new Error("只认得 ColorReader 导出的 .md 与 .csv；Kindle 的 My Clippings.txt 得先导入书");
  }

  const books = await db.all<StoredBook>("books");
  const byId = new Map(books.map((book) => [book.id, book]));
  const byTitle = new Map(books.map((book) => [book.title.trim(), book]));
  const rows = await db.all<Annotation>("annotations");

  const outcome: Outcome = {
    total: parsed.highlights.length,
    notes: parsed.notes,
    bookmarks: parsed.bookmarks,
    matched: 0,
    located: 0,
    imported: 0,
    duplicates: 0,
    books: [],
    unknownTitles: [],
  };
  // One row per book, in the order the file first mentions one.
  const perBook = new Map<string, BookOutcome>();
  const unknown = new Set<string>();

  for (const clipping of parsed.highlights) {
    // The link is worth more than the title: a renamed book still matches.
    const book =
      (clipping.bookId === null ? undefined : byId.get(clipping.bookId)) ??
      byTitle.get(clipping.title.trim());
    if (!book) {
      if (clipping.title.length > 0) unknown.add(clipping.title);
      continue;
    }
    outcome.matched += 1;
    const row = perBook.get(book.id) ?? {
      bookId: book.id,
      title: book.title,
      total: 0,
      imported: 0,
      duplicates: 0,
      unlocated: 0,
    };
    row.total += 1;

    // Where the sentence is in the chapter the file names. Knowing the chapter
    // turns "search the whole book" into "search one chapter", which is both
    // cheaper and correct when the sentence occurs twice.
    const chapterIdx = clipping.chapterIdx ?? 0;
    const chapter = await db.get<ChapterContent>("chapters", `${book.id}:${chapterIdx}`);
    const body = (chapter?.paragraphs ?? []).join("\n");
    const at = body.indexOf(clipping.text);
    if (at >= 0) outcome.located += 1;
    else row.unlocated += 1;

    // A highlight already in the library is a duplicate of itself: importing the
    // same file twice must not pile up copies.
    const known = rows.some(
      (existing) =>
        existing.bookId === book.id &&
        existing.chapterIdx === chapterIdx &&
        existing.text === clipping.text,
    );
    if (known) {
      outcome.duplicates += 1;
      row.duplicates += 1;
      perBook.set(book.id, row);
      continue;
    }
    outcome.imported += 1;
    row.imported += 1;
    perBook.set(book.id, row);

    if (dryRun) continue;
    const created = await annotationCreate(
      book.id,
      chapterIdx,
      at >= 0 ? at : 0,
      at >= 0 ? at + clipping.text.length : clipping.text.length,
      clipping.text,
      null,
      clipping.color,
      clipping.style,
    );
    if (clipping.note !== null) await annotationNote(created.id, clipping.note);
    rows.push(created);
  }

  outcome.books = [...perBook.values()];
  outcome.unknownTitles = [...unknown];
  return outcome;
}
