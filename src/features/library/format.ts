import type { BookSummary, ImportOutcome, LibrarySort } from "@/types/ipc";

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

export const sortOptions: { value: LibrarySort; label: string }[] = [
  { value: "recentlyAdded", label: "最近添加" },
  { value: "recentlyRead", label: "最近阅读" },
  { value: "titleAsc", label: "书名" },
  { value: "authorAsc", label: "作者" },
];

export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function authorLine(book: BookSummary): string {
  return book.authors.join(" / ");
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
