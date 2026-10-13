/**
 * Full-text search over the books whose text this build holds.
 *
 * Only plain-text and markdown chapters are stored (see `local/import.ts`), so
 * a foliate book searches its chapter titles and no further — which is the
 * honest answer for a book with no text to search.
 */

import { MARK_END, MARK_START } from "@/types/ipc";

import type { SearchHit } from "@/lib/bindings";
import * as db from "@/lib/local/db";
import { chaptersOf } from "./reader";
import { type StoredBook } from "./rows";

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
