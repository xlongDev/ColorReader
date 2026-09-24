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
import * as db from "@/lib/local/db";
import { loadDoc, renderFirstPagePng } from "@/lib/pdf";
import { readBook } from "@/lib/local/import";

/** A shelf row as it is stored: `BookSummary` minus the cover, plus the TOC. */
type StoredBook = Omit<BookSummary, "coverUrl"> & { toc: ChapterMeta[] };

/** One finished reading stretch, the raw material of the stats page. */
type Session = { day: string; bookId: string; seconds: number };

const SUMMARY_KEYS = ["toc"] as const;

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

async function coverUrlOf(id: string, cover: Blob | null): Promise<string | null> {
  if (!cover) return null;
  const existing = coverUrls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(cover);
  coverUrls.set(id, url);
  return url;
}

async function summaryOf(book: StoredBook): Promise<BookSummary> {
  const cover = await db.get<Blob>("files", `${book.id}:cover`);
  const { toc: _toc, ...rest } = book;
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
    };
    await db.put("books", id, row);
    await db.put("files", id, file);
    if (parsed.cover) await db.put("files", `${id}:cover`, parsed.cover);
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
  await db.put("files", `${id}:cover`, new Blob([new Uint8Array(bytes)], { type: "image/png" }));
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

/** A foliate book keeps its images inside foliate, which renders them itself;
 *  the lightbox browser lists none rather than lying about what it has.
 *  `ponytail:` enumerate the archive when the in-book image list is missed. */
export async function bookImages(_bookId: string): Promise<BookImage[]> {
  return [];
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
  const file = await db.get<Blob>("files", id);
  if (!file) throw new Error("这本书的文件不在本地存储里");
  return file.arrayBuffer();
}

/** Raw bytes of one image *inside* an EPUB. The web reader gets its images from
 *  foliate instead, so this is reachable only from the prose path's copy of the
 *  book, which the browser does not build. */
export async function bookAsset(_id: string, _path: string): Promise<ArrayBuffer> {
  return new ArrayBuffer(0);
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
  const { toc: _toc, ...rest } = book;
  return rest;
}
