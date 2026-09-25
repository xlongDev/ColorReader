/**
 * The vendored zip reader, loaded on demand.
 *
 * foliate ships @zip.js inside its own bundle and uses it for the books
 * themselves; pulling one picture out of an EPUB borrows that same copy rather
 * than adding a second dependency, and loads it lazily so it stays in the chunk
 * that already carries foliate.
 *
 * Read-only, which is all foliate ships: the browser's backup is gzipped JSON
 * because there is no writer here to borrow (see `backup.ts`).
 *
 * The shape is spelled out here because the vendored file is a bundle with no
 * declarations of its own; only what is actually used is described.
 */

export interface ZipEntry {
  filename: string;
  uncompressedSize?: number;
  /** Absent on directories. */
  getData?: (writer: unknown) => Promise<unknown>;
}

export interface ZipModule {
  /** Compression runs on the main thread: a worker would need its own bundle,
   *  and the archives here are a personal library. */
  configure: (options: { useWebWorkers?: boolean }) => void;
  ZipReader: new (reader: unknown) => {
    getEntries: () => Promise<ZipEntry[]>;
    close: () => Promise<void>;
  };
  BlobReader: new (blob: Blob) => unknown;
  BlobWriter: new (type?: string) => unknown;
}

export const zipTools = (): Promise<ZipModule> =>
  import("foliate-js/vendor/zip.js") as unknown as Promise<ZipModule>;

/** One entry's bytes, or `null` when it has no data (a directory). */
export async function entryBytes(entry: ZipEntry, tools: ZipModule): Promise<ArrayBuffer | null> {
  if (!entry.getData) return null;
  const blob = (await entry.getData(new tools.BlobWriter())) as Blob;
  return blob.arrayBuffer();
}
