/**
 * Spotting a re-imported edition of a book already on the shelf.
 *
 * A file whose bytes changed is a *new* book (`content_hash` is the identity
 * key), so a corrected epub lands next to the old one with nothing carried
 * across. This is the half of that problem the frontend owns: deciding which
 * pair of shelf rows is the same book in two editions. The other half — moving
 * the marks — is `book.migrate`, because the anchor is the highlight's text and
 * the text lives in SQL.
 *
 * The match is deliberately coarse. A re-import is usually seconds after the
 * reader edited the file, the shelf is theirs, and the cost of being wrong is
 * one question the reader answers with "两本都留".
 */

import type { BookSummary } from "@/types/ipc";

/** One book in two editions: `from` carries the marks, `to` is the new file. */
export interface Edition {
  from: BookSummary;
  to: BookSummary;
}

/** Titles and names compared loosely: case and spacing are not editions. */
function key(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function sharesAuthor(a: BookSummary, b: BookSummary): boolean {
  if (a.authors.length === 0 || b.authors.length === 0) return true;
  const ours = new Set(a.authors.map(key));
  return b.authors.some((author) => ours.has(key(author)));
}

/**
 * Pairs every freshly imported book with the shelf entry it looks like a new
 * edition of.
 *
 * `imported` are the books the run just created (or recognised as duplicates)
 * and `shelf` is the whole shelf *after* the import — the new rows have to be
 * in it, because their authors are part of the match.
 *
 * At most one candidate per new book: two entries with the same title are not
 * something to guess between, and the reader can still say no.
 */
export function editionTwins(imported: BookSummary[], shelf: BookSummary[]): Edition[] {
  const ours = new Set(imported.map((book) => book.id));
  const found: Edition[] = [];
  const claimed = new Set<string>();

  for (const book of imported) {
    const title = key(book.title);
    if (title === "") continue;
    const twin = shelf.find(
      (other) =>
        !ours.has(other.id) &&
        !claimed.has(other.id) &&
        key(other.title) === title &&
        sharesAuthor(book, other),
    );
    if (!twin) continue;
    claimed.add(twin.id);
    found.push({ from: twin, to: book });
  }
  return found;
}

/** The sentence the dialog opens with: what the old edition is carrying. */
export function editionSummary(edition: Edition, annotations: number): string {
  const parts: string[] = [];
  // `progress` is a nullable column in the generated type; a book the reader
  // never opened is `null`, and that is the same as zero here.
  const read = edition.from.progress ?? 0;
  if (read > 0) parts.push(`已读 ${Math.round(read * 100)}%`);
  if (annotations > 0) parts.push(`${annotations} 条标注`);
  if (edition.from.favorite) parts.push("已收藏");
  return parts.length > 0 ? parts.join(" · ") : "还没有读过";
}
