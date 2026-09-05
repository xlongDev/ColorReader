import { MARK_END, MARK_START, type SearchHit } from "@/types/ipc";

/**
 * Backend snippets carry the matched run wrapped in two control characters.
 * Splitting them into parts keeps the hit renderable as plain text, with no
 * markup ever reaching the DOM.
 */
export interface SnippetPart {
  text: string;
  matched: boolean;
}

export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let cursor = 0;
  while (cursor < snippet.length) {
    const open = snippet.indexOf(MARK_START, cursor);
    if (open < 0) break;
    const close = snippet.indexOf(MARK_END, open + 1);
    if (close < 0) break;
    if (open > cursor) parts.push({ text: snippet.slice(cursor, open), matched: false });
    parts.push({ text: snippet.slice(open + 1, close), matched: true });
    cursor = close + 1;
  }
  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), matched: false });
  return parts;
}

/** Same row text for a hit, whether the list is scoped to a book or not. */
export function hitLocation(hit: SearchHit, scoped: boolean): string {
  const chapter = `第 ${hit.chapterIdx + 1} 章`;
  return scoped ? chapter : `${hit.bookTitle} · ${chapter}`;
}
