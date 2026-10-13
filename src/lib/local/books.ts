/**
 * The shelf: importing a picked file, listing, editing and deleting books, and
 * handing a book's own file back out.
 *
 * One book is one row in the `books` store, its bytes in `files`, its chapters
 * in `chapters`, keyed `<id>` and `<id>:<idx>`. What a *reader* does with one
 * book is in `reader.ts`; this is what the *shelf* does.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";

import type {
  Annotation,
  Bookmark,
  BookMetadataPatch,
  BookQuery,
  BookSummary,
  ChapterContent,
  ChapterMeta,
  ImportOutcome,
  LibraryStats,
} from "@/lib/bindings";
import { filename } from "@/lib/filename";
import { countChars, pdfLines } from "@/lib/local/blocks";
import * as db from "@/lib/local/db";
import { readBook } from "@/lib/local/import";
import { loadDoc, renderFirstPagePng } from "@/lib/pdf";
import { downloadBytes } from "@/lib/local/save";
import { bookFile } from "./reader";
import {
  type SUMMARY_KEYS,
  type StoredBook,
  type StoredImage,
  bookRow,
  coverUrls,
  newId,
  now,
  patchBook,
  summaryOf,
} from "./rows";

/* ---------------------------------------------------------------- importing */

/**
 * Imports picked files.
 *
 * The desktop takes paths because its picker hands them over; a browser file
 * input hands over `File`s, so that is what this takes. A file already on the
 * shelf is reported as a duplicate rather than stored twice — title and size
 * together are the cheap stand-in for the content hash the desktop uses.
 */
export async function bookImportFiles(files: File[]): Promise<ImportOutcome[]> {
  // The shelf is read once and kept up to date as rows go in, so two copies of
  // the same file in one batch cannot both land. Imports run in parallel — each
  // one is mostly parsing — and the shelf's own duplicate test is the cheap
  // stand-in for the content hash the desktop uses.
  const shelf = await db.all<StoredBook>("books");
  const seen = new Set(shelf.map((book) => `${book.title}\u0000${book.fileSize}`));
  return Promise.all(files.map((file) => importOne(file, seen)));
}

async function importOne(file: File, seen: Set<string>): Promise<ImportOutcome> {
  try {
    const parsed = await readBook(file);
    const key = `${parsed.title}\u0000${file.size}`;
    if (seen.has(key)) {
      const clash = (await db.all<StoredBook>("books")).find(
        (book) => book.title === parsed.title && book.fileSize === file.size,
      );
      return {
        kind: "duplicate",
        path: file.name,
        id: clash?.id ?? "",
        title: parsed.title,
      };
    }
    seen.add(key);
    const id = newId();
    const stamp = now();
    const row: StoredBook = {
      id,
      title: parsed.title,
      subtitle: parsed.subtitle,
      description: parsed.description,
      language: parsed.language,
      publisher: parsed.publisher,
      format: parsed.format,
      fileSize: file.size,
      addedAt: stamp,
      updatedAt: stamp,
      lastReadAt: null,
      progress: null,
      location: null,
      favorite: false,
      authors: parsed.authors,
      tags: [],
      toc: parsed.toc,
      images: parsed.images,
    };
    await db.put("books", id, row);
    // 🔴 The bytes, not the `File`. WebKit will not store a `File` object in
    // IndexedDB and aborts the transaction doing it, so a book imported there
    // had a row and no file — see the note on `run` in `db.ts`.
    await db.put("files", id, await file.arrayBuffer());
    if (parsed.cover) {
      await db.put("files", `${id}:cover`, {
        type: parsed.cover.type,
        bytes: await parsed.cover.arrayBuffer(),
      } satisfies StoredImage);
    }
    await Promise.all(
      (parsed.chapters ?? []).map((chapter) => db.put("chapters", `${id}:${chapter.idx}`, chapter)),
    );
    if (parsed.format === "pdf") await describePdf(id);
    return { kind: "imported", path: file.name, id, title: parsed.title };
  } catch (error) {
    return {
      kind: "failed",
      path: file.name,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fills in what a PDF cannot say about itself until it can be read: its pages
 * are its table of contents, and its cover is page one.
 *
 * Both come from the reader's own pdf.js path (`lib/pdf.ts`) — the same code
 * the desktop backfills covers with — which is why this runs *after* the bytes
 * are stored: that path reads the book through `bookFile`, which in this build
 * is IndexedDB.
 */
/**
 * Every page's lines, in reading order.
 *
 * pdf.js hands over positioned runs, not paragraphs: the runs that share a
 * baseline are one line, and the document's own end-of-line markers say where a
 * line stops. Both are used — a file that marks nothing still breaks where the
 * baseline moves — and the result is one chapter per page, which is the shape
 * the reader's page index already has.
 *
 * Blank pages keep their entry. A PDF is fixed layout, so page N of the reader
 * has to stay page N of the document whatever its text did.
 */
async function pdfPages(doc: PDFDocumentProxy): Promise<ChapterContent[]> {
  const chapters: ChapterContent[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    let paragraphs: string[] = [];
    try {
      const page = await doc.getPage(number);
      paragraphs = pdfLines((await page.getTextContent()).items);
      page.cleanup();
    } catch {
      // A page pdf.js will not decode is a blank page here; its number stays.
    }
    chapters.push({ idx: number - 1, title: `第 ${number} 页`, paragraphs });
  }
  return chapters;
}

async function describePdf(id: string): Promise<void> {
  try {
    const doc = await loadDoc(id);
    // The text first: it is what the page count is *for*, and the TOC's
    // character counts are read off it rather than guessed at.
    const chapters = await pdfPages(doc);
    const toc: ChapterMeta[] = chapters.map((chapter) => ({
      idx: chapter.idx,
      title: chapter.title,
      chars: countChars(chapter.paragraphs),
    }));
    let title: string | null = null;
    try {
      const meta = (await doc.getMetadata()) as { info?: { Title?: unknown } };
      const found = meta.info?.Title;
      title = typeof found === "string" && found.trim().length > 0 ? found.trim() : null;
    } catch {
      // A document without an info dictionary keeps the file's own name.
    }
    await patchBook(id, title ? { toc, title } : { toc });
    // A scanned book extracts to nothing but blank pages; storing them would
    // only make every chapter look searchable and empty.
    if (chapters.some((chapter) => chapter.paragraphs.length > 0)) {
      await Promise.all(
        chapters.map((chapter) => db.put("chapters", `${id}:${chapter.idx}`, chapter)),
      );
    }
    const png = await renderFirstPagePng(id);
    await bookCoverSave(id, [...new Uint8Array(png)]);
  } catch {
    // A scanned or damaged PDF simply keeps the placeholder cover and one
    // chapter, which is what the shelf shows for a book it cannot open.
  }
}
/* ------------------------------------------------------------------ library */

/** The shelf, filtered and sorted the way the Rust query does it. */
export async function bookList(query: BookQuery): Promise<BookSummary[]> {
  const rows = await db.all<StoredBook>("books");
  const needle = query.search?.trim().toLowerCase() ?? "";
  const tag = query.tag?.trim().toLowerCase() ?? "";
  const kept = rows.filter((book) => {
    if (query.filter === "favorites" && !book.favorite) return false;
    if (query.filter === "recent" && book.lastReadAt === null) return false;
    if (tag && !book.tags.some((name) => name.toLowerCase() === tag)) return false;
    if (!needle) return true;
    return (
      book.title.toLowerCase().includes(needle) ||
      book.authors.some((author) => author.toLowerCase().includes(needle))
    );
  });
  const by: Record<string, (a: StoredBook, b: StoredBook) => number> = {
    recentlyAdded: (a, b) => b.addedAt - a.addedAt,
    recentlyRead: (a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0),
    progressDesc: (a, b) => (b.progress ?? 0) - (a.progress ?? 0),
    titleAsc: (a, b) => a.title.localeCompare(b.title, "zh"),
    authorAsc: (a, b) =>
      (a.authors[0] ?? "").localeCompare(b.authors[0] ?? "", "zh") ||
      a.title.localeCompare(b.title, "zh"),
  };
  const compare = by[query.sort ?? "recentlyAdded"] ?? by.recentlyAdded!;
  return Promise.all(kept.toSorted(compare).map(summaryOf));
}

export async function bookStats(): Promise<LibraryStats> {
  const rows = await db.all<StoredBook>("books");
  return {
    total: rows.length,
    favorites: rows.filter((book) => book.favorite).length,
    reading: rows.filter((book) => book.lastReadAt !== null && (book.progress ?? 0) < 0.999).length,
    finished: rows.filter((book) => (book.progress ?? 0) >= 0.999).length,
  };
}

export async function bookGet(id: string): Promise<BookSummary | null> {
  const row = await bookRow(id);
  return row ? summaryOf(row) : null;
}

export async function bookDelete(id: string): Promise<void> {
  await db.del("books", id);
  await db.del("files", id);
  await db.del("files", `${id}:cover`);
  const url = coverUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    coverUrls.delete(id);
  }
  const chapters = (await db.keys("chapters")).filter((key) => key.startsWith(`${id}:`));
  const annotations = (await db.all<Annotation>("annotations")).filter((row) => row.bookId === id);
  const bookmarks = (await db.all<Bookmark>("bookmarks")).filter((row) => row.bookId === id);
  await Promise.all([
    ...chapters.map((key) => db.del("chapters", key)),
    ...annotations.map((row) => db.del("annotations", row.id)),
    ...bookmarks.map((row) => db.del("bookmarks", row.id)),
  ]);
}

export async function bookSetFavorite(id: string, favorite: boolean): Promise<void> {
  await patchBook(id, { favorite });
}

/** The shelf's batch bar, on this side.
 *
 * One `bookDelete` / `bookSetFavorite` per id: this backend keeps its rows in
 * separate object stores, so there is no cross-store transaction to put the
 * batch in. That is the honest limit of the browser build, and the reason the
 * desktop side gets a real one. */
export async function bookDeleteMany(ids: string[]): Promise<void> {
  for (const id of ids) await bookDelete(id);
}

export async function bookSetFavoriteMany(ids: string[], favorite: boolean): Promise<void> {
  for (const id of ids) await bookSetFavorite(id, favorite);
}

export async function bookUpdate(id: string, patch: BookMetadataPatch): Promise<void> {
  await patchBook(id, {
    title: patch.title,
    subtitle: patch.subtitle,
    description: patch.description,
    language: patch.language,
    publisher: patch.publisher,
    authors: patch.authors,
  });
}

export async function bookCoverSave(id: string, bytes: number[]): Promise<void> {
  const url = coverUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    coverUrls.delete(id);
  }
  await db.put("files", `${id}:cover`, {
    type: "image/png",
    bytes: new Uint8Array(bytes).buffer,
  } satisfies StoredImage);
}
/**
 * Saves the book's own file through the browser's download.
 *
 * `path` is ignored — it is where the desktop writes, and this build has
 * nowhere to write to. The signature is the command's, because one name has to
 * answer on both sides; the name a download gets comes from here, since the row
 * holds the two fields it needs and there is no save panel to ask in.
 */
export async function bookExport(id: string, _path: string): Promise<null> {
  const book = await bookRow(id);
  downloadBytes(await bookFile(id), savedName(book));
  return null;
}

/** What a saved copy is called: the title, cleaned, plus the format's own
 *  extension — a book's format names itself except markdown, whose files are
 *  `md`. */
function savedName(book: StoredBook | null): string {
  if (!book) return "book.bin";
  const extension = book.format === "markdown" ? "md" : book.format;
  return `${filename(book.title, "book")}.${extension}`;
}
/** The `BookSummary` shape without its table of contents, for callers that
 *  build one by hand (tests). */
export function stripRow(book: StoredBook): Omit<StoredBook, (typeof SUMMARY_KEYS)[number]> {
  const { toc: _toc, images: _images, ...rest } = book;
  return rest;
}
