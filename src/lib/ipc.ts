import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { commands } from "@/lib/bindings";
import type {
  AiDelta,
  GraphProgress,
  ImportProgress,
  RagProgress,
  SourceProgress,
} from "@/lib/bindings";

/**
 * Every command that crosses as JSON is generated into `bindings.ts` straight
 * from the Rust signature (`cargo test export_bindings`) — there is no
 * hand-written mirror left to drift out of step with the backend.
 *
 * Two are hand-written because they cannot be generated: `book_asset` and
 * `book_source_file` return raw bytes over the binary channel (Rust returns
 * `tauri::ipc::Response`), a shape Specta cannot describe. They are therefore
 * excluded from codegen and typed here.
 */
export const ipc = {
  ...commands,

  /** Raw bytes of one image inside a book's source EPUB (binary channel). */
  bookAsset(id: string, path: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("book_asset", { id, path });
  },

  /** The whole stored source file (binary channel); powers pdf.js rendering. */
  bookFile(id: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("book_source_file", { id });
  },
};

/** Event the backend emits once per file while an import batch runs. */
const IMPORT_PROGRESS_EVENT = "book://import-progress";

/** Event carrying streamed AI answer chunks. */
const AI_STREAM_EVENT = "ai://stream";

/** Event carrying RAG index build progress. */
const RAG_INDEX_EVENT = "rag://index-progress";

/** Event carrying knowledge graph build progress. */
const GRAPH_BUILD_EVENT = "graph://build-progress";

/** Event carrying one book download's chapter progress. */
const SOURCE_DOWNLOAD_EVENT = "source://download-progress";

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

/** Subscribes to book download progress; no-op outside the Tauri shell. */
export async function onSourceProgress(
  handler: (progress: SourceProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<SourceProgress>(SOURCE_DOWNLOAD_EVENT, (event) => handler(event.payload));
}

/** `true` only when the renderer is hosted inside the Tauri shell. */
export const isDesktopRuntime: boolean = isTauri();

/**
 * Query body for something only the desktop app can answer.
 *
 * The web preview has no backend, so every such query owes the UI a stand-in —
 * an empty list, a default config. Taking it as an argument makes that a
 * requirement rather than a thing to remember: a new query cannot be written
 * without deciding what the browser shows.
 */
export function desktopQuery<T>(offline: T, call: () => Promise<T>): () => Promise<T> {
  return () => (isDesktopRuntime ? call() : Promise.resolve(offline));
}
