import type { BookFormat, BookSummary, ImportOutcome, LibrarySort } from "@/types/ipc";

/** Page-level shelf filter; `tags` is still a Phase 9 placeholder. */
export type ShelfFilter = "all" | "recent" | "favorites" | "tags";

const TITLES: Record<ShelfFilter, { title: string; subtitle: string }> = {
  all: { title: "书库", subtitle: "所有导入的书籍" },
  recent: { title: "最近", subtitle: "继续阅读的地方" },
  favorites: { title: "收藏", subtitle: "标星的书" },
  tags: { title: "标签", subtitle: "按标签浏览" },
};

export function titleForFilter(filter: ShelfFilter): { title: string; subtitle: string } {
  return TITLES[filter];
}

/**
 * The shelf's orders, and the direction each one comes back in.
 *
 * `desc` is what the button reads to say which way the shelf is currently
 * pointing: 最近添加 and 文件大小 are already descending, so a toggle that
 * called the untouched order "升序" would be lying about the list on screen.
 */
export const sortOptions: { value: LibrarySort; label: string; desc: boolean }[] = [
  { value: "recentlyAdded", label: "最近添加", desc: true },
  { value: "recentlyRead", label: "最近阅读", desc: true },
  { value: "progressDesc", label: "阅读进度", desc: true },
  { value: "titleAsc", label: "书名", desc: false },
  { value: "authorAsc", label: "作者", desc: false },
  { value: "formatAsc", label: "文件格式", desc: false },
  { value: "sizeDesc", label: "文件大小", desc: true },
];

export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Formats foliate renders out of the book's own XHTML + CSS.
 *
 * The four Kindle containers are one container and one parser, so they share a
 * renderer — and all four are named, because a format left out of this list
 * does not fail loudly: it falls back to the extracted-text renderer and the
 * book comes out as plain paragraphs. Two surfaces read this list and they have
 * to agree: the reader picks its renderer from it, and the notes page names an
 * annotation's position from it (`节` for a spine section, `章` for a chapter
 * the importer extracted). Adding a format to one and not the other silently
 * mislabels every highlight in it.
 */
const FOLIATE_FORMATS: ReadonlySet<BookFormat> = new Set<BookFormat>([
  "epub",
  "mobi",
  "azw",
  "azw3",
  "prc",
]);

export function isFoliateFormat(format: BookFormat): boolean {
  return FOLIATE_FORMATS.has(format);
}

export function authorLine(book: BookSummary): string {
  return book.authors.join(" / ");
}

/**
 * The book the reader was last in.
 *
 * Returns the book with the highest `lastReadAt`, or `undefined` when none
 * has been opened yet. Picking by timestamp — rather than by the first
 * `progress > 0` in the recently-added list — means the shelf always points
 * at *the book that was actually opened last*, regardless of where it sits
 * in the add order or how much of it was read.
 *
 * Pure function so the page can call it without owning the walk, and so
 * the rule is testable without rendering the shelf.
 */
export function pickContinueReading(list: BookSummary[]): BookSummary | undefined {
  let latest: BookSummary | undefined;
  for (const book of list) {
    if (book.lastReadAt === null) continue;
    const ts = book.lastReadAt;
    if (latest === undefined || ts > (latest.lastReadAt ?? ts)) latest = book;
  }
  return latest;
}

/** One line summarising an import batch, e.g. "2 本已导入，1 本重复". */
export function summarizeOutcomes(outcomes: ImportOutcome[]): string {
  const imported = outcomes.filter((o) => o.kind === "imported").length;
  const duplicates = outcomes.filter((o) => o.kind === "duplicate").length;
  const failed = outcomes.filter((o) => o.kind === "failed").length;

  const parts: string[] = [];
  if (imported > 0) parts.push(`${imported} 本已导入`);
  if (duplicates > 0) parts.push(`${duplicates} 本已在书架上`);
  if (failed > 0) parts.push(`${failed} 本失败`);

  return parts.length > 0 ? parts.join("，") : "没有可导入的文件";
}

export function failedMessage(outcome: Extract<ImportOutcome, { kind: "failed" }>): string {
  const name = outcome.path.split("/").pop() ?? outcome.path;
  return `${name}：${outcome.message}`;
}
