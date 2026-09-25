/**
 * The browser's own shelf: one IndexedDB database, no dependency.
 *
 * The desktop app keeps its library in SQLite behind the Tauri IPC; the web
 * build has no backend at all, and this is the smallest thing that lets the
 * same hooks run there — a key/value store per kind of row, and the queries
 * the shelf actually makes (one key read, one full scan, one key delete).
 *
 * Bytes live in their own store so listing the shelf never touches them: a
 * `getAll` over `books` must not page a 200 MB PDF through memory on its way to
 * a title and a cover.
 *
 * `ponytail:` no indexes and no cursor pagination — every scan is over a
 * personal library (hundreds of rows, kilobytes each). Add an index when a
 * shelf of thousands measurably stutters, not before.
 */

/** The stores, and what each one is keyed by. */
export type StoreName =
  /** `BookSummary` shape + its table of contents + cover blob, keyed by book id. */
  | "books"
  /** The imported file itself, keyed by book id. */
  | "files"
  /** One chapter's paragraphs, keyed `${bookId}:${idx}`. */
  | "chapters"
  | "annotations"
  | "bookmarks"
  /** One imported font's bytes, keyed by font id. */
  | "fonts"
  /** One small document per key: the session log, the tag names. */
  | "meta";

const STORES: StoreName[] = [
  "books",
  "files",
  "chapters",
  "annotations",
  "bookmarks",
  "fonts",
  "meta",
];

const NAME = "colorreader";
/** Bumped when a store is added: `onupgradeneeded` creates the missing ones and
 *  leaves the rest alone, so an older library keeps its books. */
const VERSION = 2;

let opening: Promise<IDBDatabase> | null = null;

/** The database, opened once per session. */
export function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("这个浏览器不支持 IndexedDB，本地书架无法使用"));
      return;
    }
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of STORES) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
      }
    };
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB 打不开")));
  });
  return opening;
}

/**
 * Runs one request against a store and settles with its result.
 *
 * 🔴 A **write** is settled by the transaction completing, not by its request
 * succeeding. A value the engine cannot clone (WebKit refuses `File` objects
 * outright) fails the transaction after the request has already reported
 * success — so waiting on the request alone reported an import as stored while
 * the store stayed empty, and the book came back later as "this book's file is
 * not in local storage". A read has nothing to wait for and settles on its own.
 */
async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const database = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const result = request(transaction.objectStore(store));
    let value: T;
    result.addEventListener("success", () => {
      value = result.result as T;
      if (mode === "readonly") resolve(value);
    });
    result.addEventListener("error", () => reject(result.error ?? new Error(`${store} 读写失败`)));
    transaction.addEventListener("complete", () => resolve(value));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error(`${store} 的写入被中止`)),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error(`${store} 写入失败`)),
    );
  });
}

export function put<T>(store: StoreName, key: string, value: T): Promise<void> {
  return run<void>(store, "readwrite", (object) => object.put(value as never, key));
}

export function get<T>(store: StoreName, key: string): Promise<T | null> {
  return run<T | null>(store, "readonly", (object) => object.get(key)).then(
    (value) => value ?? null,
  );
}

export function del(store: StoreName, key: string): Promise<void> {
  return run<void>(store, "readwrite", (object) => object.delete(key));
}

/** Empties one store. Used by a restore, which replaces rather than merges. */
export function clear(store: StoreName): Promise<void> {
  return run<void>(store, "readwrite", (object) => object.clear());
}

export function all<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, "readonly", (object) => object.getAll());
}

export function keys(store: StoreName): Promise<string[]> {
  return run<IDBValidKey[]>(store, "readonly", (object) => object.getAllKeys()).then((list) =>
    list.map(String),
  );
}
