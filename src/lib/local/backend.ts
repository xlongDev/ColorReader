/**
 * The browser's backend: the commands the shelf and the reader actually call,
 * answered from IndexedDB.
 *
 * The desktop app answers these from SQLite in Rust. The web build has no
 * Rust, so this module is swapped in as the implementation of the same command
 * names (`lib/ipc.ts` does the swap) — every hook, query and cache key above it
 * stays exactly as it is on the desktop, which is the point: the two builds
 * then differ in storage and in nothing else.
 *
 * Left out on purpose, because they need a real backend or a filesystem:
 * AI / RAG / knowledge graph / cloud sync / book sources / backup packs, and
 * font and dictionary import from a path. Those keep their existing
 * "desktop only" stubs and say so in the UI where they are offered.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

import { MARK_END, MARK_START } from "@/types/ipc";
import type {
  Annotation,
  BookImage,
  Bookmark,
  BookMetadataPatch,
  BookQuery,
  BookSummary,
  ChapterContent,
  ChapterMeta,
  ImportOutcome,
  LibraryStats,
  ReadingStats,
  SearchHit,
  TagSummary,
} from "@/lib/bindings";

import { countChars, pdfLines } from "@/lib/local/blocks";
import { downloadBytes } from "@/lib/local/save";
import { filename } from "@/lib/filename";
import type { LocalFont } from "@/types/ipc";
import {
  renderCsv,
  renderCsvMany,
  renderMarkdown,
  renderMarkdownMany,
  type Notes,
} from "@/lib/local/notes";
import * as db from "@/lib/local/db";
import { loadDoc, renderFirstPagePng } from "@/lib/pdf";
import { entryBytes, zipTools } from "@/lib/local/zip";
import { readBook } from "@/lib/local/import";

/** A shelf row as it is stored: `BookSummary` minus the cover, plus the TOC. */
type StoredBook = Omit<BookSummary, "coverUrl"> & {
  toc: ChapterMeta[];
  /** Every picture the book shows, collected at import. The lightbox walks it;
   *  the desktop keeps the same list in its own database. */
  images: BookImage[];
};

/**
 * An image in the store: the bytes plus the type to read them back as.
 *
 * A `Blob` would carry both at once, and Chromium is happy to keep one — but
 * WebKit refuses to store a `File` at all and aborts the transaction, so the
 * bytes go in as an `ArrayBuffer`, which every engine clones.
 */
type StoredImage = { type: string; bytes: ArrayBuffer };

/** One finished reading stretch, the raw material of the stats page. */
type Session = { day: string; bookId: string; seconds: number };

/** Row fields that never belong to a `BookSummary`: the table of contents and
 *  the picture list both stay in the row. */
const SUMMARY_KEYS = ["toc", "images"] as const;

const now = () => Math.floor(Date.now() / 1000);
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Two digits, the way a date key wants them. */
const two = (value: number) => String(value).padStart(2, "0");

/** Local `YYYY-MM-DD`, the day key the stats page groups by. */
function dayOf(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** Cover object URLs, one per book, made once and kept for the session. */
const coverUrls = new Map<string, string>();

/** A book's cover as a Blob, from either shape the store has held: the image
 *  itself (older rows) or its bytes with their type. */
async function coverOf(id: string): Promise<Blob | null> {
  const stored = await db.get<StoredImage | Blob>("files", `${id}:cover`);
  if (!stored) return null;
  return stored instanceof Blob ? stored : new Blob([stored.bytes], { type: stored.type });
}

async function coverUrlOf(id: string, cover: Blob | null): Promise<string | null> {
  if (!cover) return null;
  const existing = coverUrls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(cover);
  coverUrls.set(id, url);
  return url;
}

async function summaryOf(book: StoredBook): Promise<BookSummary> {
  const cover = await coverOf(book.id);
  const { toc: _toc, images: _images, ...rest } = book;
  return { ...rest, coverUrl: await coverUrlOf(book.id, cover) };
}

/** One book's row, or `null`. */
async function bookRow(id: string): Promise<StoredBook | null> {
  return db.get<StoredBook>("books", id);
}

/** Writes a row back, bumping `updatedAt` unless the caller says otherwise. */
async function patchBook(id: string, patch: Partial<StoredBook>): Promise<StoredBook | null> {
  const row = await bookRow(id);
  if (!row) return null;
  const next: StoredBook = { ...row, ...patch, updatedAt: now() };
  await db.put("books", id, next);
  return next;
}

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

/* ------------------------------------------------------------------- reader */

/** Every stored chapter of one book, in reading order. */
async function chaptersOf(bookId: string): Promise<ChapterContent[]> {
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
  // Collected during import, when every section's document was parsed anyway.
  // A row written before that existed has none, and reads as a book with no
  // pictures until it is imported again.
  return (await bookRow(bookId))?.images ?? [];
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

/* --------------------------------------------------------------------- data */

export async function bookFile(id: string): Promise<ArrayBuffer> {
  const stored = await db.get<ArrayBuffer | Blob>("files", id);
  if (!stored) throw new Error("这本书的文件不在本地存储里");
  // Older rows hold the imported `File`; newer ones hold its bytes.
  return stored instanceof Blob ? stored.arrayBuffer() : stored;
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

/* -------------------------------------------------------------------- stats */

async function sessions(): Promise<Session[]> {
  return (await db.get<Session[]>("meta", "sessions")) ?? [];
}

export async function statsRecordSession(bookId: string, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  const log = await sessions();
  // One row per day and book: the page only ever sums them, so a day of reading
  // is a handful of rows rather than one per stretch.
  const day = dayOf(now());
  const row = log.find((entry) => entry.day === day && entry.bookId === bookId);
  if (row) row.seconds += seconds;
  else log.push({ day, bookId, seconds });
  await db.put("meta", "sessions", log);
}

const STATS_WINDOW = 180;
const TOP_WINDOW = 30;

export async function statsReading(): Promise<ReadingStats> {
  const log = await sessions();
  const titles = new Map((await db.all<StoredBook>("books")).map((book) => [book.id, book.title]));
  const today = dayOf(now());
  const byDay = new Map<string, number>();
  const byBook = new Map<string, number>();
  for (const entry of log) {
    byDay.set(entry.day, (byDay.get(entry.day) ?? 0) + entry.seconds);
    if (inWindow(entry.day, TOP_WINDOW)) {
      byBook.set(entry.bookId, (byBook.get(entry.bookId) ?? 0) + entry.seconds);
    }
  }

  const days: { day: string; seconds: number }[] = [];
  for (let back = STATS_WINDOW - 1; back >= 0; back -= 1) {
    const day = dayOf(now() - back * 86_400);
    days.push({ day, seconds: byDay.get(day) ?? 0 });
  }

  let streak = 0;
  for (let back = 0; back < 400; back += 1) {
    const seconds = byDay.get(dayOf(now() - back * 86_400)) ?? 0;
    if (seconds > 0) streak += 1;
    else if (back > 0) break;
    // A day with no reading yet does not end a streak that is still running.
  }

  let best = 0;
  let run = 0;
  for (const day of [...byDay.keys()].toSorted()) {
    const previous = dayOf(Date.parse(`${day}T00:00:00`) / 1000 - 86_400);
    run = byDay.has(previous) ? run + 1 : 1;
    best = Math.max(best, run);
  }

  return {
    todaySeconds: byDay.get(today) ?? 0,
    weekSeconds: days.slice(-7).reduce((total, day) => total + day.seconds, 0),
    totalSeconds: log.reduce((total, entry) => total + entry.seconds, 0),
    streak,
    daysRead: byDay.size,
    days,
    bestStreak: best,
    topBooks: [...byBook.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([bookId, seconds]) => ({
        bookId,
        title: titles.get(bookId) ?? "（已删除）",
        seconds,
      })),
  };
}

export async function statsClear(): Promise<void> {
  await db.put("meta", "sessions", []);
}

/** Whether a `YYYY-MM-DD` day is within the last `days` days, today included. */
function inWindow(day: string, days: number): boolean {
  const limit = dayOf(now() - (days - 1) * 86_400);
  return day >= limit;
}

/* --------------------------------------------------------------------- tags */

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

/* ------------------------------------------------------------------- search */

/** Characters of context on each side of a hit. */
const SNIPPET = 40;

/** The text around a hit, with the hit marked the way the search page reads it. */
function snippetAround(body: string, at: number, length: number): string {
  const from = Math.max(0, at - SNIPPET);
  const to = Math.min(body.length, at + length + SNIPPET);
  const head = body.slice(from, at);
  const hit = body.slice(at, at + length);
  const tail = body.slice(at + length, to);
  return `${from > 0 ? "…" : ""}${head}${MARK_START}${hit}${MARK_END}${tail}${to < body.length ? "…" : ""}`;
}

/**
 * Full-text search over the books whose text this build holds.
 *
 * Only plain-text and markdown chapters are stored (see `local/import.ts`), so
 * a foliate book searches its chapter titles and no further — which is the
 * honest answer for a book with no text to search.
 */
export async function searchQuery(
  needle: string,
  bookId: string | null,
  limit: number | null,
): Promise<SearchHit[]> {
  const query = needle.trim().toLowerCase();
  if (query.length === 0) return [];
  const cap = limit ?? 50;
  const books = (await db.all<StoredBook>("books")).filter((book) => !bookId || book.id === bookId);
  const perBook = await Promise.all(books.map((book) => hitsInBook(book, query, needle)));
  const hits: SearchHit[] = [];
  for (const group of perBook) {
    for (const hit of group) {
      if (hits.length >= cap) return hits;
      hits.push(hit);
    }
  }
  return hits;
}

/**
 * One book's hits: a chapter's title first, then its text.
 *
 * Searched over the extracted chapters rather than the imported TOC, because
 * the chapter index in a hit is the one the reader's `goTo` understands — the
 * two would only agree on a book whose TOC happened to have one entry per
 * spine document.
 */
async function hitsInBook(book: StoredBook, query: string, needle: string): Promise<SearchHit[]> {
  const chapters = await chaptersOf(book.id);
  const hits: SearchHit[] = [];
  if (chapters.length === 0) {
    // No text was extracted, so the titles are the honest answer.
    for (const entry of book.toc) {
      if (entry.title.toLowerCase().includes(query)) {
        hits.push({
          bookId: book.id,
          bookTitle: book.title,
          chapterIdx: entry.idx,
          chapterTitle: entry.title,
          snippet: entry.title,
          offset: 0,
        });
      }
    }
    return hits;
  }
  for (const chapter of chapters) {
    const base = {
      bookId: book.id,
      bookTitle: book.title,
      chapterIdx: chapter.idx,
      chapterTitle: chapter.title,
    };
    if (chapter.title.toLowerCase().includes(query)) {
      hits.push({ ...base, snippet: chapter.title, offset: 0 });
      continue;
    }
    const body = chapter.paragraphs.join("\n");
    const at = body.toLowerCase().indexOf(query);
    if (at < 0) continue;
    hits.push({ ...base, snippet: snippetAround(body, at, needle.length), offset: at });
  }
  return hits;
}

/** The `BookSummary` shape without its table of contents, for callers that
 *  build one by hand (tests). */
export function stripRow(book: StoredBook): Omit<StoredBook, (typeof SUMMARY_KEYS)[number]> {
  const { toc: _toc, images: _images, ...rest } = book;
  return rest;
}

/* -------------------------------------------------------------------- fonts */

/** One imported font as it is stored: the bytes, and where the name came from. */
type StoredFont = {
  id: string;
  name: string;
  /** The name the reader picked it under. Kept for the same reason the desktop
   *  keeps its stored filename: resolving an id is a lookup, never a guess. */
  file: string;
  bytes: ArrayBuffer;
  addedAt: number;
};

/** Blob URLs, one per font, made once and kept until the font goes. */
const fontUrls = new Map<string, string>();

function fontUrlOf(font: StoredFont): string {
  const existing = fontUrls.get(font.id);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([font.bytes]));
  fontUrls.set(font.id, url);
  return url;
}

/** The shape the reader's font picker reads — the same one the desktop answers
 *  with, so `fontFaceCss` never has to know which side it is on. */
const asLocalFont = (font: StoredFont): LocalFont => ({
  id: font.id,
  name: font.name,
  file: font.file,
  addedAt: font.addedAt,
  url: fontUrlOf(font),
});

export async function fontList(): Promise<LocalFont[]> {
  const rows = await db.all<StoredFont>("fonts");
  return rows.toSorted((a, b) => a.addedAt - b.addedAt).map(asLocalFont);
}

/**
 * Imports one picked font file.
 *
 * The `FontFace` load is the check, not a formality: it is what a corrupt file
 * — or a `.zip` someone renamed — fails, and failing here, while the reader is
 * looking at the button, is worth far more than a family that quietly renders
 * in the fallback stack the next time a book is opened.
 *
 * The loaded face is then thrown away on purpose. A book section is its own
 * document, so the face has to be declared *inside* it by CSS (`fontFaceCss`
 * takes the URL from here); registering it in this document's `document.fonts`
 * would style the app's own chrome and nothing else.
 */
export async function fontImportFile(file: File): Promise<LocalFont> {
  const bytes = await file.arrayBuffer();
  const id = newId();
  await new FontFace(`cr-${id}`, bytes).load();
  const name = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
  const font: StoredFont = { id, name, file: file.name, bytes, addedAt: now() };
  await db.put("fonts", id, font);
  return asLocalFont(font);
}

export async function fontDelete(id: string): Promise<null> {
  await db.del("fonts", id);
  const url = fontUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    fontUrls.delete(id);
  }
  return null;
}

/* ------------------------------------------------------------------ backup */

/** The browser's own backup, re-exported so `fromLocal` can reach it. The
 *  implementation lives in its own file: it is a couple of hundred lines of
 *  archive work that the shelf never touches. */
export { backupExport as backupSave, backupRestore as backupLoad } from "@/lib/local/backup";

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

/** One book's highlights as a download. The desktop's command takes a path and
 *  reads the format off its extension; here the name the file gets is the one
 *  its save panel would have offered. */
export async function notesSave(bookId: string, name: string, format: string): Promise<null> {
  const notes = await notesOf(bookId);
  if (!notes) throw new Error("这本书不在库里");
  const body = format === "csv" ? renderCsv(notes) : renderMarkdown(notes);
  downloadBytes(
    new Blob([body], { type: notesType(format) }),
    `${filename(name, "标注与笔记")}.${format}`,
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
  const body = format === "csv" ? renderCsvMany(books) : renderMarkdownMany(books);
  downloadBytes(
    new Blob([body], { type: notesType(format) }),
    `${filename(name, "笔记")}.${format}`,
  );
  return null;
}
