/**
 * The browser's own backup: one file holding the whole library.
 *
 * Deliberately **not** the desktop's format. That archive is the data directory
 * verbatim — a SQLite file, the imported fonts, the dictionaries — and there is
 * no browser shape of it to write. What both builds can agree on is the thing
 * that matters: a file the reader can keep somewhere else and put back.
 *
 * Deliberately not a ZIP either. foliate ships the zip *reader* it needs for
 * books and nothing that writes one, and hand-rolling the format to save a
 * wrapper is a poor trade. What a browser does have natively is gzip
 * (`CompressionStream`), so the archive is one gzipped JSON document: the
 * manifest, every row, and the books themselves as base64. A book's bytes
 * inflate by a third in base64, and gzip takes that straight back off.
 *
 * Why the books are in it, when they can be imported again: a restore has to
 * put each annotation back on the book it was made in, and a re-import mints a
 * new id. Without the bytes there is nothing to match on, and the annotations —
 * the one thing here that cannot be rebuilt — would come back unanchored.
 *
 * Chapters do travel, though a re-import would also produce them: extracting
 * them again means parsing every section of every book (minutes on a full
 * shelf), and a restore that finishes immediately is worth the archive size.
 */

import { filename } from "@/lib/filename";
import { downloadBytes } from "@/lib/local/save";
import * as db from "@/lib/local/db";

/** Identifies the archive, and the shape of what is inside it. */
const FORMAT = "colorreader-web-backup";
const VERSION = 1;

/** One row as it is stored, under the key it is stored by. */
type Row = { key: string; value: unknown };

/** What one backup or restore moved, matching the desktop's own summary. */
export interface BackupSummary {
  files: number;
  bytes: number;
}

interface Archive {
  format: string;
  version: number;
  exportedAt: number;
  /** Rows by store name. */
  library: Record<string, Row[]>;
  /** Books and their real byte count, so the summary need not be recomputed. */
  files: number;
  bytes: number;
  /** The `files` store as it is: book bytes and covers, keyed the same way
   *  (`<id>`, `<id>:cover`), base64 because JSON carries no bytes. */
  payloads: Record<string, string>;
}

const TABLES = ["books", "chapters", "annotations", "bookmarks", "meta"] as const;

/** 32 K at a time: `String.fromCharCode(...huge)` overflows the call stack. */
const CHUNK = 0x8000;

const toBase64 = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let at = 0; at < view.length; at += CHUNK) {
    binary += String.fromCharCode(...view.subarray(at, at + CHUNK));
  }
  return btoa(binary);
};

const fromBase64 = (text: string): ArrayBuffer => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes.buffer;
};

/** Whether this browser can gzip a stream. Every current engine can; the check
 *  is here because an uncompressed archive is a working fallback, not a crash. */
const canCompress = (): boolean =>
  typeof CompressionStream === "function" && typeof DecompressionStream === "function";

async function pack(text: string): Promise<Blob> {
  if (!canCompress()) return new Blob([text], { type: "application/json" });
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function unpack(file: Blob): Promise<string> {
  // A file written by a browser without `CompressionStream` is plain JSON, and
  // a `.gz` read by one without `DecompressionStream` should say so plainly.
  if (!canCompress()) return file.text();
  const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

const two = (value: number): string => String(value).padStart(2, "0");

/** `20260925-1347` — sorts, and reads as a date at a glance. */
const stamp = (): string => {
  const now = new Date();
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
};

/**
 * Packs the library and hands it to the reader as a download.
 *
 * Answers with what it moved so the settings row can say so — the same sentence
 * the desktop shows, because it is the same fact.
 */
export async function backupExport(): Promise<BackupSummary> {
  const library: Record<string, Row[]> = {};
  for (const table of TABLES) {
    const rows = await db.all<unknown>(table);
    const keys = await db.keys(table);
    library[table] = keys.map((key, index) => ({ key, value: rows[index] }));
  }

  const payloads: Record<string, string> = {};
  let files = 0;
  let bytes = 0;
  for (const key of await db.keys("files")) {
    const stored = await db.get<ArrayBuffer | Blob>("files", key);
    if (!stored) continue;
    const payload = stored instanceof Blob ? await stored.arrayBuffer() : stored;
    payloads[key] = toBase64(payload);
    if (!key.endsWith(":cover")) {
      files += 1;
      bytes += payload.byteLength;
    }
  }

  const archive: Archive = {
    format: FORMAT,
    version: VERSION,
    exportedAt: Math.floor(Date.now() / 1000),
    library,
    files,
    bytes,
    payloads,
  };
  const blob = await pack(JSON.stringify(archive));
  const name = filename(`colorreader-backup-${stamp()}`, "colorreader-backup");
  downloadBytes(blob, `${name}.${canCompress() ? "json.gz" : "json"}`);
  return { files, bytes };
}

/**
 * Replaces the library with what the archive holds.
 *
 * Replaces, not merges: this is what "restore" means on the desktop too, and a
 * merge would have to decide what to do about two rows with one id. The stores
 * are emptied before anything is written, and the caller asks first — the
 * archive the reader is holding is the only way back, where the desktop still
 * has the displaced directory on disk.
 */
export async function backupRestore(file: File): Promise<BackupSummary> {
  const archive = JSON.parse(await unpack(file)) as Partial<Archive>;
  if (archive.format !== FORMAT) throw new Error("这不是书库备份");
  if ((archive.version ?? 0) > VERSION) throw new Error("备份来自更新的版本，请先升级");
  if (!archive.library) throw new Error("备份里没有书目数据");

  for (const table of TABLES) await db.clear(table);
  await db.clear("files");
  for (const [table, rows] of Object.entries(archive.library)) {
    for (const row of rows) await db.put(table as never, row.key, row.value);
  }
  // Bytes last: a row without its file is a book that will not open, and the
  // other order leaves exactly that if the restore is interrupted.
  for (const [key, payload] of Object.entries(archive.payloads ?? {})) {
    await db.put("files", key, fromBase64(payload));
  }

  return { files: archive.files ?? 0, bytes: archive.bytes ?? 0 };
}
