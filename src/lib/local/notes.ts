/**
 * Highlights to a file the reader can take away: Markdown or CSV, one book or
 * a selection across several.
 *
 * The shapes here are **the desktop's**, which are in turn half of a contract
 * with *importing*: `clippings::parse_csv` finds its columns by name, so a file
 * without `书名` cannot be read back at all. That is why this is a second
 * implementation rather than a port — moving `export.rs` over here would leave
 * the importer on the other side of a shape only one of them still knows.
 *
 * The two implementations are pinned together by their tests: the expectations
 * below are the strings `library/export.rs` asserts, copied over deliberately.
 * Change one side and the other goes red, which is the point.
 */

/** The scheme the app registers, so a row can be reopened where it came from. */
const SCHEME = "colorreader";

/** A byte-order mark, so Excel opens the file as UTF-8 instead of guessing the
 *  system code page — the difference between 三体 and mojibake. */
const CSV_BOM = "\uFEFF";

/** The one column layout both CSV exporters write, and the one the importer
 *  reads. Adding a column here is invisible there until something asks. */
const CSV_HEADER = "书名,章节,原文,笔记,颜色,样式,链接\n";

/** One highlight, as much of it as an export needs. */
export interface NoteEntry {
  id: string;
  chapterIdx: number;
  text: string;
  note: string | null;
  color: string | null;
  style: string | null;
}

/** One book's highlights. */
export interface Notes {
  id: string;
  title: string;
  authors: string[];
  /** 0–1, as the shelf stores it. */
  progress: number;
  entries: NoteEntry[];
}

/** The link a highlight carries back into the app. Pinned to the string
 *  `parseDeepLink` reads (`src/lib/deeplink.ts`). */
export const link = (bookId: string, annotationId: string): string =>
  `${SCHEME}://book/${bookId}?annotation=${annotationId}`;

/** One blockquote. Every line gets its own `>`, so a highlight spanning
 *  paragraphs stays a single quote instead of nesting its second half. */
const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** The line under the title: who wrote it, how much there is, how far in. */
function summary(notes: Notes): string {
  const noted = notes.entries.filter((entry) => entry.note !== null).length;
  const parts = [`${notes.entries.length} 条标注`];
  if (noted > 0) parts.push(`${noted} 条有笔记`);
  if (notes.progress > 0) parts.push(`阅读进度 ${Math.round(notes.progress * 100)}%`);
  const line = parts.join(" · ");
  return notes.authors.length === 0 ? line : `${notes.authors.join("、")} · ${line}`;
}

/** The line under the title of a cross-book export. Progress is per book and
 *  means nothing across several, so each section keeps its own. */
function summaryMany(books: Notes[]): string {
  const highlights = books.reduce((total, book) => total + book.entries.length, 0);
  const noted = books.flatMap((book) => book.entries).filter((entry) => entry.note !== null).length;
  const parts = [`${books.length} 本书`, `${highlights} 条标注`];
  if (noted > 0) parts.push(`${noted} 条有笔记`);
  return parts.join(" · ");
}

/** One book's highlights, chapter by chapter, pushed onto `blocks`.
 *
 *  A heading is emitted when the chapter actually changes: the list is already
 *  in reading order, so a group never needs buffering. */
function body(notes: Notes, heading: string, blocks: string[]): void {
  if (notes.entries.length === 0) blocks.push("这本书还没有标注。");
  let chapter: number | null = null;
  for (const entry of notes.entries) {
    if (chapter !== entry.chapterIdx) {
      chapter = entry.chapterIdx;
      blocks.push(`${heading} 第 ${entry.chapterIdx + 1} 章`);
    }
    blocks.push(quote(entry.text));
    if (entry.note !== null) blocks.push(entry.note);
    // The way back in. A link rather than a bare URL: note apps render the one
    // and leave the other as text that has to be copied out by hand.
    blocks.push(`[在 ColorReader 中打开](${link(notes.id, entry.id)})`);
  }
}

export function renderMarkdown(notes: Notes): string {
  const blocks = [`# 《${notes.title}》标注与笔记`, summary(notes)];
  body(notes, "##", blocks);
  // Trailing newline: the file is meant to be opened by other tools, and a text
  // file that ends without one makes every one of them complain.
  return `${blocks.join("\n\n")}\n`;
}

/** Several books as one page, a section each. The book heading and the chapter
 *  headings differ by a level: two `##`s in a row would read as two of the same
 *  thing, and one of them is a book. */
export function renderMarkdownMany(books: Notes[]): string {
  const blocks = ["# 笔记导出", summaryMany(books)];
  for (const notes of books) {
    blocks.push(`## 《${notes.title}》`);
    if (notes.authors.length > 0) blocks.push(notes.authors.join("、"));
    body(notes, "###", blocks);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Quotes a field when it holds a delimiter, a quote or a line break — the
 *  three things that would otherwise split one row into several. */
const field = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** One CSV row: the book it came from, then the highlight. */
function row(notes: Notes, entry: NoteEntry): string {
  return [
    field(notes.title),
    entry.chapterIdx + 1,
    field(entry.text),
    field(entry.note ?? ""),
    // Left empty rather than filled with the defaults the UI applies: "never
    // chosen" and "chose yellow" are different facts, and the file should not
    // invent one of them.
    field(entry.color ?? ""),
    field(entry.style ?? ""),
    // Raw rather than as a `[text](url)` pair: a spreadsheet column is a value,
    // and the URL is what the app answers to.
    field(link(notes.id, entry.id)),
  ].join(",");
}

export function renderCsv(notes: Notes): string {
  return CSV_BOM + CSV_HEADER + notes.entries.map((entry) => `${row(notes, entry)}\n`).join("");
}

/** Several books as one CSV table. One header, one shape: a single-book file
 *  leads with `书名` exactly as a cross-book one does, even though the title
 *  repeats down every row — the importer matches a clipping to a book by title,
 *  so a file that never names its book cannot be read back. */
export function renderCsvMany(books: Notes[]): string {
  return (
    CSV_BOM +
    CSV_HEADER +
    books.flatMap((notes) => notes.entries.map((entry) => `${row(notes, entry)}\n`)).join("")
  );
}
