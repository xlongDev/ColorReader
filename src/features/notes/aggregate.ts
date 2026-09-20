import type { Annotation, BookFormat, BookSummary } from "@/types/ipc";

import { isFoliateFormat } from "@/features/library/format";

/**
 * The notes page's shape, as pure functions.
 *
 * The page is a view over highlights the reader made *in books* — there is no
 * note of its own anywhere in here, and nothing in this module writes. What it
 * decides is only how those rows are arranged and narrowed, which is exactly
 * the part worth testing without a DOM.
 */

/** One highlight with the book it came from. */
export interface NoteEntry {
  book: BookSummary;
  annotation: Annotation;
}

/** One book's highlights, in reading order. */
export interface BookNotes {
  book: BookSummary;
  entries: NoteEntry[];
}

/**
 * The books that have something to show, in the order they were handed over.
 *
 * The shelf's sort is the page's sort. `useBooks({ sort: "recentlyRead" })`
 * already answers "which book was I last in", and re-deriving it here would be
 * a second opinion about the same list. Books with no highlights drop out: the
 * page is an index of what was marked, not a catalogue of what was read.
 *
 * Entries are sorted by (chapter, offset) rather than trusting the backend's
 * order, because the page interleaves several books' lists and a chapter that
 * was highlighted out of order would otherwise show its passages shuffled.
 */
export function groupByBook(
  books: readonly BookSummary[],
  annotations: ReadonlyMap<string, readonly Annotation[]>,
): BookNotes[] {
  const groups: BookNotes[] = [];
  for (const book of books) {
    const entries = (annotations.get(book.id) ?? [])
      .toSorted((a, b) => a.chapterIdx - b.chapterIdx || a.startChar - b.startChar)
      .map((annotation) => ({ book, annotation }));
    if (entries.length > 0) groups.push({ book, entries });
  }
  return groups;
}

export interface NoteFilter {
  /** Free text; blank means everything. */
  query: string;
  /** Keep only the highlights the reader wrote something on. */
  onlyNoted: boolean;
}

/**
 * Narrows the groups to the entries that match.
 *
 * The needle is matched against the passage, the note and the book alike — a
 * reader looking for 演化 neither knows nor should have to know whether they
 * wrote it or the author did, and remembering which book a line came from is
 * precisely the work this page is here to do for them.
 *
 * Groups that lose every entry drop out rather than leaving an empty heading.
 */
export function filterNotes(groups: readonly BookNotes[], filter: NoteFilter): BookNotes[] {
  const needle = filter.query.trim().toLowerCase();
  const keep = ({ book, annotation }: NoteEntry) => {
    if (filter.onlyNoted && annotation.note === null) return false;
    if (needle === "") return true;
    return (
      annotation.text.toLowerCase().includes(needle) ||
      (annotation.note ?? "").toLowerCase().includes(needle) ||
      book.title.toLowerCase().includes(needle) ||
      book.authors.some((author) => author.toLowerCase().includes(needle))
    );
  };

  const out: BookNotes[] = [];
  for (const group of groups) {
    const entries = group.entries.filter(keep);
    if (entries.length > 0) out.push({ book: group.book, entries });
  }
  return out;
}

/** Highlights and notes across every group, for the header's tally. */
export function tally(groups: readonly BookNotes[]): { highlights: number; notes: number } {
  let highlights = 0;
  let notes = 0;
  for (const group of groups) {
    highlights += group.entries.length;
    for (const { annotation } of group.entries) {
      if (annotation.note !== null) notes += 1;
    }
  }
  return { highlights, notes };
}

/**
 * Narrows the groups to a set of highlight ids — selection mode's own view.
 *
 * A copy rather than a filter in place: `shown` is memoised and shared, and the
 * batch bar's count, the delete and the export all read it.
 */
export function keepEntries(groups: readonly BookNotes[], ids: ReadonlySet<string>): BookNotes[] {
  const out: BookNotes[] = [];
  for (const group of groups) {
    const entries = group.entries.filter((entry) => ids.has(entry.annotation.id));
    if (entries.length > 0) out.push({ book: group.book, entries });
  }
  return out;
}

/**
 * The two arguments the export command wants, derived from what the page shows.
 *
 * `bookIds` is the order the screen put the books in and `ids` is every
 * highlight in reading order. The backend groups by book and keeps reading
 * order inside each, so handing it the books is what makes the file read the
 * way the screen does — and handing it the ids is what keeps a search or the
 * 有笔记 filter from being silently ignored.
 *
 * A function rather than something inlined at the two call sites (the toolbar's
 * export and the selection's), because the pairing *is* the contract: a caller
 * that passed the ids alone would lose the order, and one that passed the books
 * alone would lose the narrowing.
 */
export function exportPayload(groups: readonly BookNotes[]): {
  bookIds: string[];
  ids: string[];
} {
  const bookIds: string[] = [];
  const ids: string[] = [];
  for (const group of groups) {
    if (group.entries.length === 0) continue;
    bookIds.push(group.book.id);
    for (const { annotation } of group.entries) ids.push(annotation.id);
  }
  return { bookIds, ids };
}

/**
 * The ink a highlight paints with.
 *
 * `null` reads as yellow, which is what the backend means by it: the column
 * predates per-highlight colour, so every row written before it reads back
 * null and has always rendered yellow. Falling back to a different value here
 * would recolour old highlights on one page and not the other.
 */
export function inkColor(annotation: Annotation): string {
  return annotation.color ?? "#ffd12e";
}

/**
 * What a highlight's `chapterIdx` counts in a given book.
 *
 * A foliate-rendered book is a container of spine items, so the index is a
 * *section*, not the chapter a table of contents lists. `ReaderPage` picks its
 * renderer off the same list (`isFoliateFormat`), and the two surfaces have to
 * name the same number the same way — a reader who sees 第 4 节 in the book
 * should not see 第 4 章 here.
 */
export function unitLabel(format: BookFormat): string {
  return isFoliateFormat(format) ? "节" : "章";
}
