/**
 * The download half of notes: one book's highlights, or the selection the notes
 * page is showing, as Markdown or CSV.
 *
 * The rendering is `notes.ts`; this is the command that asks for it and hands
 * the result to the browser's download.
 */

import type { Annotation } from "@/lib/bindings";
import { filename } from "@/lib/filename";
import * as db from "@/lib/local/db";
import {
  type Dialect,
  renderCsv,
  renderCsvMany,
  renderMarkdown,
  renderMarkdownMany,
  type Notes,
} from "@/lib/local/notes";
import { downloadBytes } from "@/lib/local/save";
import { bookRow } from "./rows";

/* ------------------------------------------------------------------- notes */

/** One book's highlights, in reading order — the order the desktop's own
 *  `ORDER BY chapter_idx, start_char` gives, so both builds export a book the
 *  same way round. */
async function notesOf(bookId: string): Promise<Notes | null> {
  const book = await bookRow(bookId);
  if (!book) return null;
  const rows = (await db.all<Annotation>("annotations"))
    .filter((row) => row.bookId === bookId)
    .toSorted((a, b) => a.chapterIdx - b.chapterIdx || a.startChar - b.startChar);
  return {
    id: bookId,
    title: book.title,
    authors: book.authors,
    progress: book.progress ?? 0,
    entries: rows.map((row) => ({
      id: row.id,
      chapterIdx: row.chapterIdx,
      text: row.text,
      note: row.note ?? null,
      color: row.color ?? null,
      style: row.style ?? null,
    })),
  };
}

const notesType = (format: string): string =>
  format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8";

/** What the file is called on disk. Obsidian is a Markdown dialect rather than
 *  a format — its vault only ever indexes `.md` — so what the reader picks
 *  travels under Markdown's extension. The desktop's save panel says the same
 *  thing from the same list of formats. */
const notesExtension = (format: string): string => (format === "csv" ? "csv" : "md");

/** The dialect the reader asked for, as the renderer names it. */
const notesDialect = (format: string): Dialect => (format === "obsidian" ? "obsidian" : "plain");

/** One book's highlights as a download. The desktop's command takes a path and
 *  reads the format off its extension; here the name the file gets is the one
 *  its save panel would have offered. */
export async function notesSave(bookId: string, name: string, format: string): Promise<null> {
  const notes = await notesOf(bookId);
  if (!notes) throw new Error("这本书不在库里");
  const body = format === "csv" ? renderCsv(notes) : renderMarkdown(notes, notesDialect(format));
  downloadBytes(
    new Blob([body], { type: notesType(format) }),
    `${filename(name, "标注与笔记")}.${notesExtension(format)}`,
  );
  return null;
}

/** The notes page exports what it is *showing*: `ids` decides which rows
 *  survive, and `bookIds` carries the page's own order, so the file groups the
 *  way the screen does — the same contract as the desktop's selection export. */
export async function notesSaveSelection(
  bookIds: string[],
  ids: string[],
  name: string,
  format: string,
): Promise<null> {
  const wanted = new Set(ids);
  const books: Notes[] = [];
  for (const bookId of bookIds) {
    const notes = await notesOf(bookId);
    if (!notes) continue;
    notes.entries = notes.entries.filter((entry) => wanted.has(entry.id));
    if (notes.entries.length > 0) books.push(notes);
  }
  const body =
    format === "csv" ? renderCsvMany(books) : renderMarkdownMany(books, notesDialect(format));
  downloadBytes(
    new Blob([body], { type: notesType(format) }),
    `${filename(name, "笔记")}.${notesExtension(format)}`,
  );
  return null;
}
