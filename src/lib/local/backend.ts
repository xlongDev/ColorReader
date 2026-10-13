/**
 * The browser's backend: the commands the shelf and the reader actually call,
 * answered from IndexedDB.
 *
 * The desktop app answers these from SQLite in Rust. The web build has no
 * Rust, so this module is swapped in as the implementation of the same command
 * names (`lib/ipc.ts` does the swap) — every hook, query and cache key above it
 * stays exactly as it is on the desktop, which is the point: the two builds
 * then differ in storage and in nothing else.
 *
 * Left out on purpose, because they need a real backend or a filesystem:
 * AI / RAG / knowledge graph / cloud sync / book sources / backup packs, and
 * importing from a *path* — the desktop's own dialog is what produces one.
 * Those keep their existing "desktop only" stubs and say so in the UI where
 * they are offered. Importing the file the browser picked is another matter and
 * is answered here (books, fonts, and MDict dictionaries).
 *
 * The commands live in one file per domain, next to the rows they touch
 * (`books`, `reader`, `annotations`, `bookmarks`, `stats`, `tags`, `search`,
 * `fonts`, `dictionaries`, `notesSave`, `clippingsImport`), with what more than
 * one of them calls in `rows`. This file is the surface `ipc.ts` picks a
 * command from by name, and nothing else — a command belongs to the domain
 * file that owns its store.
 */

/**
 * The browser's own backup: re-exported so `fromLocal` can reach it. The
 * implementation lives in its own file — a couple of hundred lines of archive
 * work that the shelf never touches.
 */
export { backupExport as backupSave, backupRestore as backupLoad } from "@/lib/local/backup";

export * from "./books";
export * from "./reader";
export * from "./annotations";
export * from "./bookmarks";
export * from "./stats";
export * from "./tags";
export * from "./search";
export * from "./fonts";
export * from "./dictionaries";
export * from "./notesSave";
export * from "./clippingsImport";
