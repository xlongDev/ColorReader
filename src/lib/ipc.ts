import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AiConfig,
  AiDelta,
  AiMessage,
  Annotation,
  BookQuery,
  BookSummary,
  BookImage,
  Bookmark,
  ChapterContent,
  ChapterMeta,
  GraphProgress,
  GraphStatus,
  GraphView,
  ImportOutcome,
  ImportProgress,
  LibraryStats,
  NewAnnotation,
  NewBookmark,
  RagProgress,
  RagStatus,
  SearchHit,
  SourceBook,
  SourceChapter,
  SourceDownloaded,
  SourceEntry,
  SourceProgress,
  SourceRules,
  SyncChange,
  SyncConfig,
  SystemInfo,
} from "@/types/ipc";

/** Event the backend emits once per file while an import batch runs. */
export const IMPORT_PROGRESS_EVENT = "book://import-progress";

/** Event carrying streamed AI answer chunks. */
export const AI_STREAM_EVENT = "ai://stream";

/** Event carrying RAG index build progress. */
export const RAG_INDEX_EVENT = "rag://index-progress";

/** Event carrying knowledge graph build progress. */
export const GRAPH_BUILD_EVENT = "graph://build-progress";

/**
 * Typed wrapper around Tauri's `invoke` with a single source of truth for
 * command names. Add a case here and in `src-tauri/src/commands/` together.
 */
export const ipc = {
  systemInfo(): Promise<SystemInfo> {
    return invoke<SystemInfo>("system_info");
  },

  bookList(query: BookQuery): Promise<BookSummary[]> {
    return invoke<BookSummary[]>("book_list", { query });
  },

  bookGet(id: string): Promise<BookSummary | null> {
    return invoke<BookSummary | null>("book_get", { id });
  },

  bookStats(): Promise<LibraryStats> {
    return invoke<LibraryStats>("book_stats");
  },

  /** Raw bytes of one image inside a book's source EPUB (binary channel). */
  bookAsset(id: string, path: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("book_asset", { id, path });
  },

  /** The whole stored source file (binary channel); powers pdf.js rendering. */
  bookFile(id: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("book_source_file", { id });
  },

  /** Stores a PNG the frontend rendered as this book's cover (PDF first page). */
  bookCoverSave(id: string, bytes: ArrayBuffer): Promise<void> {
    return invoke("book_cover_save", { id, bytes: Array.from(new Uint8Array(bytes)) });
  },

  /** Every image in the book, in reading order, with its chapter index. */
  bookImages(id: string): Promise<BookImage[]> {
    return invoke<BookImage[]>("book_images", { id });
  },

  bookImport(paths: string[], password?: string): Promise<ImportOutcome[]> {
    return invoke<ImportOutcome[]>("book_import", { paths, password: password ?? null });
  },

  /**
   * Writes one book to a book pack. The destination extension picks the format:
   * `.ctzx` encrypts and therefore needs a password.
   */
  packExport(id: string, path: string, password?: string): Promise<void> {
    return invoke<void>("pack_export", { id, path, password: password ?? null });
  },

  bookDelete(id: string): Promise<void> {
    return invoke<void>("book_delete", { id });
  },

  bookSetFavorite(id: string, favorite: boolean): Promise<void> {
    return invoke<void>("book_set_favorite", { id, favorite });
  },

  readerToc(bookId: string): Promise<ChapterMeta[]> {
    return invoke<ChapterMeta[]>("reader_toc", { bookId });
  },

  readerChapter(bookId: string, idx: number): Promise<ChapterContent> {
    return invoke<ChapterContent>("reader_chapter", { bookId, idx });
  },

  readerSetProgress(bookId: string, progress: number): Promise<void> {
    return invoke<void>("reader_set_progress", { bookId, progress });
  },

  annotationCreate(input: NewAnnotation): Promise<Annotation> {
    return invoke<Annotation>("annotation_create", {
      bookId: input.bookId,
      chapterIdx: input.chapterIdx,
      startChar: input.startChar,
      endChar: input.endChar,
      text: input.text,
    });
  },

  annotationList(bookId: string): Promise<Annotation[]> {
    return invoke<Annotation[]>("annotation_list", { bookId });
  },

  annotationDelete(id: string): Promise<void> {
    return invoke<void>("annotation_delete", { id });
  },

  bookmarkCreate(input: NewBookmark): Promise<Bookmark> {
    return invoke<Bookmark>("bookmark_create", {
      bookId: input.bookId,
      chapterIdx: input.chapterIdx,
      fraction: input.fraction,
      label: input.label,
    });
  },

  bookmarkList(bookId: string): Promise<Bookmark[]> {
    return invoke<Bookmark[]>("bookmark_list", { bookId });
  },

  bookmarkDelete(id: string): Promise<void> {
    return invoke<void>("bookmark_delete", { id });
  },

  /** Full-text lookup. `bookId === null` searches the whole library. */
  searchQuery(needle: string, bookId: string | null): Promise<SearchHit[]> {
    return invoke<SearchHit[]>("search_query", { needle, bookId });
  },

  aiGetConfig(): Promise<AiConfig> {
    return invoke<AiConfig>("ai_get_config");
  },

  aiSetConfig(config: AiConfig): Promise<AiConfig> {
    return invoke<AiConfig>("ai_set_config", { config });
  },

  /** Proves endpoint, key and model work together. Does not persist. */
  aiTest(config: AiConfig): Promise<void> {
    return invoke<void>("ai_test", { config });
  },

  /**
   * Streams an answer through `ai://stream`. Resolves once the request is
   * accepted; the answer arrives as events terminated by `done: true`.
   */
  aiChat(requestId: string, messages: AiMessage[]): Promise<void> {
    return invoke<void>("ai_chat", { requestId, messages });
  },

  /** Index status for one book plus library totals. */
  ragStatus(bookId: string): Promise<RagStatus> {
    return invoke<RagStatus>("rag_status", { bookId });
  },

  /** Rebuilds the embedding index for one book; progress arrives as events. */
  ragIndexBook(bookId: string): Promise<number> {
    return invoke<number>("rag_index_book", { bookId });
  },

  /**
   * Retrieval-backed answer, streamed through `ai://stream` like `aiChat`.
   * Citations arrive on the final event.
   */
  ragChat(requestId: string, question: string, bookId: string | null): Promise<void> {
    return invoke<void>("rag_chat", { requestId, question, bookId });
  },

  /** Node and edge counts for one book's knowledge graph. */
  graphStatus(bookId: string): Promise<GraphStatus> {
    return invoke<GraphStatus>("graph_status", { bookId });
  },

  /** Rebuilds the graph chapter by chapter; progress arrives as events. */
  graphBuild(bookId: string): Promise<number> {
    return invoke<number>("graph_build", { bookId });
  },

  /** All entities when `entity` is null, otherwise that entity's relations. */
  graphQuery(bookId: string, entity: string | null): Promise<GraphView> {
    return invoke<GraphView>("graph_query", { bookId, entity });
  },

  sourceList(): Promise<SourceEntry[]> {
    return invoke<SourceEntry[]>("source_list");
  },

  sourceSave(id: string | null, def: SourceRules): Promise<string> {
    return invoke<string>("source_save", { id, def });
  },

  sourceDelete(id: string): Promise<void> {
    return invoke<void>("source_delete", { id });
  },

  sourceSearch(sourceId: string, keyword: string): Promise<SourceBook[]> {
    return invoke<SourceBook[]>("source_search", { sourceId, keyword });
  },

  sourceBook(sourceId: string, bookUrl: string): Promise<SourceBook> {
    return invoke<SourceBook>("source_book", { sourceId, bookUrl });
  },

  sourceChapters(sourceId: string, bookUrl: string): Promise<SourceChapter[]> {
    return invoke<SourceChapter[]>("source_chapters", { sourceId, bookUrl });
  },

  sourceDownload(sourceId: string, bookUrl: string): Promise<SourceDownloaded> {
    return invoke<SourceDownloaded>("source_download", { sourceId, bookUrl });
  },

  syncGetConfig(): Promise<SyncConfig> {
    return invoke<SyncConfig>("sync_get_config");
  },

  syncSetConfig(config: SyncConfig): Promise<SyncConfig> {
    return invoke<SyncConfig>("sync_set_config", { config });
  },

  syncTest(config: SyncConfig): Promise<void> {
    return invoke<void>("sync_test", { config });
  },

  syncNow(config: SyncConfig): Promise<SyncChange[]> {
    return invoke<SyncChange[]>("sync_now", { config });
  },
} as const;

/** Subscribes to backend import progress; no-op outside the Tauri shell. */
export async function onImportProgress(
  handler: (progress: ImportProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<ImportProgress>(IMPORT_PROGRESS_EVENT, (event) => handler(event.payload));
}

/** Subscribes to streamed AI chunks; no-op outside the Tauri shell. */
export async function onAiStream(
  handler: (delta: AiDelta) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<AiDelta>(AI_STREAM_EVENT, (event) => handler(event.payload));
}

/** Subscribes to RAG index progress; no-op outside the Tauri shell. */
export async function onRagProgress(
  handler: (progress: RagProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<RagProgress>(RAG_INDEX_EVENT, (event) => handler(event.payload));
}

/** Subscribes to graph build progress; no-op outside the Tauri shell. */
export async function onGraphProgress(
  handler: (progress: GraphProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<GraphProgress>(GRAPH_BUILD_EVENT, (event) => handler(event.payload));
}

/** Event carrying one book download's chapter progress. */
export const SOURCE_DOWNLOAD_EVENT = "source://download-progress";

/** Subscribes to book download progress; no-op outside the Tauri shell. */
export async function onSourceProgress(
  handler: (progress: SourceProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<SourceProgress>(SOURCE_DOWNLOAD_EVENT, (event) => handler(event.payload));
}

/** `true` only when the renderer is hosted inside the Tauri shell. */
export const isDesktopRuntime: boolean = isTauri();
