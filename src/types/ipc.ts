/** Mirrors `src-tauri/src/commands/system.rs`. */

export interface SystemInfo {
  appName: string;
  appVersion: string;
  os: string;
  arch: string;
  webview: string | null;
  dataDir: string;
  uptimeMs: number;
}

/** Mirrors `src-tauri/src/library/repository.rs`. */

export type BookFormat = "epub" | "pdf" | "mobi" | "fb2" | "cbz" | "markdown" | "txt";

export type LibraryFilter = "all" | "recent" | "favorites";

export type LibrarySort =
  "recentlyAdded" | "recentlyRead" | "titleAsc" | "authorAsc" | "oldestAdded";

export interface BookQuery {
  filter?: LibraryFilter;
  sort?: LibrarySort;
  search?: string;
}

export interface BookSummary {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  format: BookFormat;
  fileSize: number;
  /** URL on the `colorreader` resource protocol, or `null` without a cover. */
  coverUrl: string | null;
  addedAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  /** 0..1 */
  progress: number;
  /**
   * Opaque last-position anchor for engines a fraction cannot resume — a CFI
   * for foliate-rendered Kindle books. `null` for every other format.
   */
  location: string | null;
  favorite: boolean;
  authors: string[];
  tags: string[];
}

export interface LibraryStats {
  total: number;
  favorites: number;
  reading: number;
  finished: number;
}

/** Mirrors `src-tauri/src/library/import.rs`. */
export type ImportOutcome =
  | { kind: "imported"; path: string; id: string; title: string }
  | { kind: "duplicate"; path: string; id: string; title: string }
  | { kind: "failed"; path: string; message: string };

/** Payload of the `book://import-progress` event. */
export interface ImportProgress {
  done: number;
  total: number;
  path: string;
}

/** Mirrors `src-tauri/src/library/chapters.rs`. */

export interface ChapterMeta {
  idx: number;
  title: string;
  /** Character count of the whole chapter, used for progress mapping. */
  chars: number;
}

/** One in-book image: the chapter it sits in and its archive entry path. */
export interface BookImage {
  chapterIdx: number;
  path: string;
}

export interface ChapterContent {
  idx: number;
  title: string;
  paragraphs: string[];
}

/** Mirrors `src-tauri/src/library/annotations.rs`. */

export interface Annotation {
  id: string;
  bookId: string;
  chapterIdx: number;
  /** UTF-16 code-unit offsets into the chapter's joined text. */
  startChar: number;
  endChar: number;
  text: string;
  /**
   * Re-anchoring key for foliate-rendered books (a CFI). Kindle sections do
   * not line up with the importer's chapter indices, so a mobi highlight can
   * only be re-located inside the engine that owns the document. `null` for
   * every format the (chapter, offset) pair already locates.
   */
  cfi: string | null;
  createdAt: number;
}

/** Input for `annotation.create`. */
export interface NewAnnotation {
  bookId: string;
  chapterIdx: number;
  startChar: number;
  endChar: number;
  text: string;
  cfi?: string;
}

/** Mirrors `src-tauri/src/library/bookmarks.rs`. */

export interface Bookmark {
  id: string;
  bookId: string;
  chapterIdx: number;
  /** Scroll fraction inside the chapter, 0..1. */
  fraction: number;
  /** List snippet, typically chapter title plus position. */
  label: string;
  createdAt: number;
}

/** Input for `bookmark.create`. */
export interface NewBookmark {
  bookId: string;
  chapterIdx: number;
  fraction: number;
  label: string;
}

/** Mirrors `src-tauri/src/library/search.rs`. */

export interface SearchHit {
  bookId: string;
  bookTitle: string;
  chapterIdx: number;
  chapterTitle: string;
  /**
   * Text around the match. The matched run is wrapped in `MARK_START` (`\u0002`)
   * and `MARK_END` (`\u0003`); `parseSnippet` turns it into renderable parts.
   */
  snippet: string;
  /** Character offset of the match inside the chapter's joined text. */
  offset: number;
}

/** Characters the backend wraps a match in. Mirrors `search.rs`. */
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";

/** Mirrors `src-tauri/src/ai/mod.rs`. */

export interface AiConfig {
  /** Origin only, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Empty for local endpoints that need no key. */
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** Embedding model for RAG; empty disables library-wide retrieval. */
  embeddingModel: string;
  /** Reranker for retrieval; empty disables the second-stage ranking. */
  rerankModel: string;
}

export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

/** Payload of the `ai://stream` event. */
export interface AiDelta {
  /** Echoed back so a reopened panel can ignore a stream it no longer owns. */
  requestId: string;
  text: string | null;
  done: boolean;
  finishReason: string | null;
  error: string | null;
  /** RAG sources; present only on the final event of a retrieval answer. */
  citations?: RagHit[];
}

/** One retrieved chunk, shown as a citation. Mirrors `library/rag.rs`. */
export interface RagHit {
  bookId: string;
  bookTitle: string;
  chapterIdx: number;
  /** Offset into the chapter's joined text, same space the reader navigates. */
  startChar: number;
  score: number;
  text: string;
}

/** Payload of the `rag://index-progress` event. */
export interface RagProgress {
  done: number;
  total: number;
}

/** Mirrors `commands/rag.rs`. */
export interface RagStatus {
  bookChunks: number;
  libraryChunks: number;
  embeddingModel: string;
}

/** Mirrors `src-tauri/src/library/graph.rs`. */

export interface GraphEntity {
  name: string;
  kind: string;
  mentions: number;
}

export interface GraphRelation {
  subject: string;
  relation: string;
  object: string;
  evidence: string;
  /** Chapter the relation first appeared in. */
  chapterIdx: number;
}

/** All entities, or the neighborhood of one entity. */
export interface GraphView {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/** Mirrors `commands/graph.rs`. */
export interface GraphStatus {
  entities: number;
  relations: number;
  model: string;
}

/** Payload of the `graph://build-progress` event. */
export interface GraphProgress {
  done: number;
  total: number;
}

/** Mirrors `src-tauri/src/library/graph.rs`. */

export interface GraphEntity {
  name: string;
  kind: string;
  mentions: number;
}

export interface GraphRelation {
  subject: string;
  relation: string;
  object: string;
  evidence: string;
  /** Chapter the relation first appeared in. */
  chapterIdx: number;
}

/** All entities, or the neighborhood of one entity. */
export interface GraphView {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/** Mirrors `commands/graph.rs`. */
export interface GraphStatus {
  entities: number;
  relations: number;
  model: string;
}

/** Payload of the `graph://build-progress` event. */
export interface GraphProgress {
  done: number;
  total: number;
}

/** Rule groups of one online book source; see `library/source.rs`. */
export interface SourceRules {
  name: string;
  baseUrl: string;
  search: {
    url: string;
    list: string;
    title: string;
    author: string;
    intro: string;
    cover: string;
    bookUrl: string;
  };
  book: { title: string; author: string; intro: string; cover: string };
  chapters: { list: string; title: string; url: string };
  content: { paragraphs: string };
}

/** Mirrors `commands/source.rs`. */
export interface SourceEntry {
  id: string;
  name: string;
  def: SourceRules;
}

export interface SourceBook {
  title: string;
  author: string;
  intro: string;
  cover: string;
  url: string;
}

export interface SourceChapter {
  title: string;
  url: string;
}

export interface SourceDownloaded {
  bookId: string;
  title: string;
  duplicate: boolean;
}

/** Payload of the `source://download-progress` event. */
export interface SourceProgress {
  done: number;
  total: number;
  chapter: string;
}

/** WebDAV sync settings; see `library/sync.rs`. */
export interface SyncConfig {
  /** WebDAV collection, e.g. `https://dav.example.com/dav/ColorReader`. */
  url: string;
  /** Empty means the server needs no authentication. */
  username: string;
  password: string;
}

/** Per-book merge outcome of `sync.now`. */
export interface SyncChange {
  decision: "uploaded" | "downloaded" | "remoteOnly" | "unchanged";
  title: string;
  /** 0..1 reading position that was kept or applied. */
  progress: number;
}

/** Mirrors `src-tauri/src/tts.rs` — the Edge read-aloud service. */

/** One voice the service offers. */
export interface EdgeVoice {
  /** The service's id, e.g. `zh-CN-YunjianNeural`. */
  shortName: string;
  /** Display name, e.g. `Yunjian`. */
  name: string;
  /** BCP-47 locale, e.g. `zh-CN`. */
  locale: string;
  /** What the voice is styled for: `Novel`, `News`, `Dialect`. */
  categories: string;
}

/** One word inside a clip, `at` seconds from its start. */
export interface EdgeWord {
  at: number;
  text: string;
}

/** One utterance of Edge speech. */
export interface EdgeClip {
  /** 24 kHz mono MP3, base64. */
  audio: string;
  words: EdgeWord[];
}
