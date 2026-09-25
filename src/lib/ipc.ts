import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { commands } from "@/lib/bindings";
import type { LocalFont } from "@/types/ipc";
import type { BackupSummary } from "@/lib/bindings";
import type {
  AiDelta,
  GraphProgress,
  ImportOutcome,
  ImportProgress,
  RagProgress,
  SourceProgress,
} from "@/lib/bindings";

/** `true` only when the renderer is hosted inside the Tauri shell. */
export const isDesktopRuntime: boolean = isTauri();

/**
 * The commands the web build answers for itself.
 *
 * Same names, same shapes, storage swapped: IndexedDB in the browser, SQLite in
 * Rust. Everything above this line — hooks, query keys, caches — is then the
 * same code on both sides, which is the point of routing it here rather than
 * branching in fifteen hooks.
 *
 * Loaded on first use, not at import: the browser backend pulls in foliate's
 * book parsing and the reader's pdf.js path, and the desktop — which has Rust
 * for all of this — should not carry 25 kB of it in its main chunk.
 *
 * The ones left out are the ones that need a real backend (AI, RAG, graph,
 * sync, book sources, backup packs) or a filesystem (font and dictionary
 * import); those keep their existing "desktop only" behaviour.
 */
const LOCAL_COMMANDS = [
  "bookImportFiles",
  "bookList",
  "bookStats",
  "bookGet",
  "bookDelete",
  "bookSetFavorite",
  "bookUpdate",
  "bookCoverSave",
  "bookExport",
  "bookImages",
  "fontList",
  "fontDelete",
  "readerToc",
  "readerChapter",
  "readerSetProgress",
  "annotationList",
  "annotationCreate",
  "annotationDelete",
  "annotationDeleteMany",
  "annotationUpdate",
  "annotationAnchor",
  "annotationNote",
  "bookmarkList",
  "bookmarkCreate",
  "bookmarkDelete",
  "statsReading",
  "statsRecordSession",
  "statsClear",
  "tagList",
  "bookSetTags",
  "tagDelete",
  "searchQuery",
  "bookFile",
] as const;

/** One browser command, resolved when it is first called. Loose on purpose:
 *  the types the callers see are `LocalCommands` below, taken from the
 *  generated bindings, so a mismatch is reported at the implementation. */
const fromLocal =
  (name: string) =>
  (...args: unknown[]): Promise<unknown> =>
    import("@/lib/local/backend").then((module) => {
      const call = (module as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
      if (!call) throw new Error(`本地后端没有 ${name}`);
      return call(...args);
    });

/** What the browser answers: the same names the generated commands have, so a
 *  caller cannot tell the two builds apart. */
/** `bookFile` / `bookAsset` carry raw bytes and are hand-written on `ipc` below,
 *  so they are not part of the generated set this picks from. */
type LocalCommands = Pick<
  typeof commands,
  Exclude<(typeof LOCAL_COMMANDS)[number], "bookAsset" | "bookFile" | "bookImportFiles">
> & {
  /** Browser-only: the desktop imports by path instead. */
  bookImportFiles: (files: File[]) => Promise<ImportOutcome[]>;
};

const local: Partial<Record<keyof LocalCommands, (...args: never[]) => unknown>> = isDesktopRuntime
  ? {}
  : Object.fromEntries(LOCAL_COMMANDS.map((name) => [name, fromLocal(name)]));

/**
 * Every command that crosses as JSON is generated into `bindings.ts` straight
 * from the Rust signature (`cargo test export_bindings`) — there is no
 * hand-written mirror left to drift out of step with the backend.
 *
 * Three are hand-written because they cannot be generated: `book_asset` and
 * `book_source_file` return raw bytes over the binary channel (Rust returns
 * `tauri::ipc::Response`), a shape Specta cannot describe, and the webview
 * snapshot does too. They are therefore excluded from codegen and typed here.
 */
export const ipc = {
  ...commands,
  // Nothing at runtime on the desktop — the cast only keeps the names visible to
  // callers, so the web build's shelf and reader share one call site.
  ...(local as LocalCommands),

  /** Raw bytes of one image inside a book's source EPUB (binary channel). */
  bookAsset(id: string, path: string): Promise<ArrayBuffer> {
    if (!isDesktopRuntime) return fromLocal("bookAsset")(id, path) as Promise<ArrayBuffer>;
    return invoke<ArrayBuffer>("book_asset", { id, path });
  },

  /** The whole stored source file (binary channel); powers pdf.js rendering. */
  bookFile(id: string): Promise<ArrayBuffer> {
    if (!isDesktopRuntime) return fromLocal("bookFile")(id) as Promise<ArrayBuffer>;
    return invoke<ArrayBuffer>("book_source_file", { id });
  },

  /**
   * The browser's own archive: packs the library into a ZIP and downloads it.
   *
   * Browser-only. The desktop's archive is its data directory verbatim — a
   * SQLite file, the fonts, the dictionaries — and there is no browser shape of
   * that to write. What both keep is the thing that matters: a file the reader
   * can put somewhere else and put back.
   */
  backupSave(): Promise<BackupSummary> {
    if (isDesktopRuntime) throw new Error("桌面端走 backup_export（数据目录）");
    return fromLocal("backupSave")() as Promise<BackupSummary>;
  },

  /** Puts one of those archives back. Replaces the library, as the desktop
   *  does: a merge would have to decide what two rows with one id mean. */
  backupLoad(file: File): Promise<BackupSummary> {
    if (isDesktopRuntime) throw new Error("桌面端走 backup_stage（路径）");
    return fromLocal("backupLoad")(file) as Promise<BackupSummary>;
  },

  /**
   * Imports a font the *browser* picked.
   *
   * Browser-only, and for the same reason as `bookImportFiles`: the desktop
   * takes a path from its native dialog (`fontImport`), the browser can only
   * hand over the file itself. Everything after that — the bytes, the URL the
   * face is declared from — is the same on both sides.
   */
  fontImportFile(file: File): Promise<LocalFont> {
    if (isDesktopRuntime) {
      throw new Error("桌面端走 font_import（路径），这里是浏览器端的入口");
    }
    return fromLocal("fontImportFile")(file) as Promise<LocalFont>;
  },

  /**
   * Imports files the *browser* picked. The desktop takes paths from its native
   * dialog instead (`bookImport`); this exists so the shelf's import button has
   * one shape to call in both builds.
   */
  bookImportFiles(files: File[]) {
    if (isDesktopRuntime) {
      throw new Error("桌面端走 bookImport（路径），这里是浏览器端的入口");
    }
    return fromLocal("bookImportFiles")(files) as Promise<ImportOutcome[]>;
  },

  /**
   * PNG snapshot of one region of the running webview, in viewport CSS px —
   * the texture the 「仿真」page curl is drawn from (binary channel).
   */
  webviewCaptureRegion(region: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("webview_capture_region", { region });
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
