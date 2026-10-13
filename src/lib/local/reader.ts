/**
 * One book, as the reader reads it: its chapters, its bytes, the entries inside
 * it, and where the reader left off.
 *
 * The positions and the progress are the desktop's contract — a bookmark and a
 * search hit address a chapter by the same index the TOC carries — so these
 * commands answer the same shapes `bindings.ts` gives the Rust side.
 */

import type { BookImage, ChapterContent, ChapterMeta } from "@/lib/bindings";
import * as db from "@/lib/local/db";
import { readBookImages } from "@/lib/local/import";
import { entryBytes, zipTools } from "@/lib/local/zip";
import { bookRow, now, patchBook } from "./rows";

/* ------------------------------------------------------------------- reader */

/** Every stored chapter of one book, in reading order. */
export async function chaptersOf(bookId: string): Promise<ChapterContent[]> {
  const prefix = `${bookId}:`;
  const keys = (await db.keys("chapters")).filter((key) => key.startsWith(prefix));
  const rows = await Promise.all(keys.map((key) => db.get<ChapterContent>("chapters", key)));
  return rows
    .filter((row): row is ChapterContent => row !== null)
    .toSorted((a, b) => a.idx - b.idx);
}

/**
 * The chapters the reader pages through.
 *
 * The row's own table, which the importer wrote from the extracted prose — the
 * desktop answers this from its own spine extraction, and the two have to be
 * the same list: a chapter's index is what a search hit, a bookmark and the
 * chapter list all address, and the reader's position is a fraction weighted by
 * these character counts.
 */
export async function readerToc(bookId: string): Promise<ChapterMeta[]> {
  return (await bookRow(bookId))?.toc ?? [];
}

export async function readerChapter(bookId: string, idx: number): Promise<ChapterContent | null> {
  return db.get<ChapterContent>("chapters", `${bookId}:${idx}`);
}

export async function bookImages(bookId: string): Promise<BookImage[]> {
  const row = await bookRow(bookId);
  if (!row) return [];
  // Collected during import, when every section's document was parsed anyway.
  if (row.images) return row.images;

  // A row written before that existed has none, and there is nowhere else to
  // get one: the browser's chapter text carries no image markers the way the
  // desktop's does (see `blocks.ts`), so the list is rebuilt from the book's
  // own bytes. That is a whole-book parse, so it happens once per book and the
  // answer is kept — an empty list included, which is what stops a book with no
  // pictures from being walked again on every open.
  const images = await readBookImages(
    new File([await bookFile(bookId)], `${row.title}.${row.format}`),
  );
  // Straight to the store rather than through `patchBook`: `updatedAt` is what
  // the shelf sorts a freshly-touched book by, and opening a book is not an
  // edit.
  await db.put("books", bookId, { ...row, images });
  return images;
}

export async function readerSetProgress(
  bookId: string,
  progress: number | null,
  location: string | null,
): Promise<void> {
  await patchBook(bookId, {
    progress,
    location,
    lastReadAt: now(),
  });
}
export async function bookFile(id: string): Promise<ArrayBuffer> {
  const stored = await db.get<ArrayBuffer | Blob>("files", id);
  if (!stored) throw new Error("这本书的文件不在本地存储里");
  // Older rows hold the imported `File`; newer ones hold its bytes.
  return stored instanceof Blob ? stored.arrayBuffer() : stored;
}
/**
 * Raw bytes of one entry inside a book.
 *
 * The desktop reads it off disk through its own archive reader. The browser
 * has the container's bytes in the store, so it opens the EPUB and pulls the
 * entry out — every picture the lightbox lists is reached this way. A MOBI
 * addresses its pictures by record index, which would mean a second reader of
 * that format here; those keep the URL foliate decoded when the page was
 * rendered, and this refuses rather than guessing.
 */
export async function bookAsset(id: string, path: string): Promise<ArrayBuffer> {
  if (path.startsWith("kindle:")) throw new Error("Kindle 书的图片请在正文里点开");
  const bytes = await bookFile(id);
  const tools = await zipTools();
  tools.configure({ useWebWorkers: false });
  const reader = new tools.ZipReader(new tools.BlobReader(new Blob([bytes])));
  try {
    const entries = await reader.getEntries();
    const decoded = decodeURIComponent(path);
    const entry =
      entries.find((candidate) => candidate.filename === path) ??
      entries.find((candidate) => decodeURIComponent(candidate.filename) === decoded) ??
      entries.find(
        (candidate) =>
          candidate.filename.slice(candidate.filename.lastIndexOf("/") + 1) ===
          decoded.slice(decoded.lastIndexOf("/") + 1),
      );
    const payload = entry ? await entryBytes(entry, tools) : null;
    if (!payload) throw new Error("书里没有这张图");
    return payload;
  } finally {
    await reader.close().catch(() => {});
  }
}
