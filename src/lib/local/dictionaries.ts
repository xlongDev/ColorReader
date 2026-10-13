/**
 * Imported MDict dictionaries, and the lookups against them.
 *
 * The desktop keeps the same facts in a settings row and the files in a
 * directory next to the library; here the whole bundle is one row, because a
 * browser has no directory to put it in and no path to name it by.
 */

import type { LocalDictionary } from "@/types/ipc";

import type { Lookup } from "@/lib/bindings";
import { createLogger } from "@/lib/log";
import * as db from "@/lib/local/db";
import * as mdict from "@/lib/local/mdict";
import { newId, now } from "./rows";

// `logger`, not the `log` this module's convention would suggest: `log` is
// already the reading session log inside two of the functions below.
const logger = createLogger("local.backend");
/* ------------------------------------------------------------ dictionaries */

/**
 * One imported dictionary as it is stored: the bundle's bytes and what its
 * header said about it.
 *
 * The desktop keeps the same facts in a settings row and the files in a
 * directory next to the library; here the whole bundle is one row, because a
 * browser has no directory to put it in and no path to name it by.
 */
type StoredDictionary = {
  id: string;
  name: string;
  /** Which reader opens the bundle. Only `mdict` can be imported here — see
   *  `dictionaryImportFile`. */
  kind: string;
  wordcount: number;
  addedAt: number;
  bytes: ArrayBuffer;
};

const MDICT = "mdict";

/** Parsed indexes, keyed by dictionary id.
 *
 *  `ponytail:` held for the session and never evicted — a reader has a handful
 *  of dictionaries, and walking a multi-megabyte block index on every selection
 *  is the thing worth avoiding. A `ponytail:` LRU belongs here if that stops
 *  being true. */
const dictionaryIndexes = new Map<string, mdict.MdictIndex>();

const asLocalDictionary = (row: StoredDictionary): LocalDictionary => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  wordcount: row.wordcount,
  addedAt: row.addedAt,
});

/** Every imported dictionary, in the order the reader added them. */
export async function dictionaryList(): Promise<LocalDictionary[]> {
  const rows = await db.all<StoredDictionary>("dictionaries");
  return rows.toSorted((a, b) => a.addedAt - b.addedAt).map(asLocalDictionary);
}

/**
 * Imports one picked `.mdx`.
 *
 * **StarDict is refused, by name.** The desktop takes a `.ifo` and finds its
 * two siblings in the same directory; a browser gets files, not directories,
 * and asking a reader to pick three of them by hand is a worse answer than
 * saying which one format works. MDict is a single file, which is the shape a
 * file picker actually hands over — and it is the shape most Chinese
 * dictionaries ship in.
 *
 * The index is walked here rather than on the first lookup, so a file this
 * build cannot read is refused while the reader is still looking at the button.
 */
export async function dictionaryImportFile(file: File): Promise<LocalDictionary> {
  if (!/\.mdx$/i.test(file.name)) {
    throw new Error("浏览器端只能导入 MDict 词典（.mdx）；StarDict 词典请在桌面端导入");
  }
  const bytes = await file.arrayBuffer();
  const index = await mdict.openIndex(bytes);
  const name = index.metadata.title || file.name.replace(/\.[^.]+$/, "").trim();
  if (!name) throw new Error("这本 MDict 词典没有名字");
  if ((await dictionaryList()).some((entry) => entry.name === name)) {
    throw new Error(`《${name}》已经导入过了`);
  }

  const id = newId();
  const row: StoredDictionary = {
    id,
    name,
    kind: MDICT,
    wordcount: index.wordcount,
    addedAt: now(),
    bytes,
  };
  await db.put("dictionaries", id, row);
  dictionaryIndexes.set(id, index);
  return asLocalDictionary(row);
}

/** Forgets one dictionary. The row is authoritative: once it is gone the
 *  dictionary is gone, and the index cache is only a cache. */
export async function dictionaryDelete(id: string): Promise<null> {
  await db.del("dictionaries", id);
  dictionaryIndexes.delete(id);
  return null;
}

/**
 * Looks `term` up in the imported dictionaries, first hit wins.
 *
 * The three answers are the desktop's three: `found` names the dictionary it
 * came from, `missing` means there was a dictionary and it did not carry the
 * term, and `unavailable` means there is nothing local to ask — which is also
 * what a browser says about the *platform* dictionary, because outside the
 * Tauri shell there is no `dictionary::define` to call. Both of the last two
 * fall through to AI in the popup; only `missing` is worth telling the reader
 * about.
 */
export async function lookupDictionary(term: string): Promise<Lookup> {
  const wanted = term.trim();
  if (wanted === "") return { status: "unavailable" };

  const rows = (await db.all<StoredDictionary>("dictionaries")).toSorted(
    (a, b) => a.addedAt - b.addedAt,
  );
  for (const row of rows) {
    try {
      let index = dictionaryIndexes.get(row.id);
      if (!index) {
        index = await mdict.openIndex(row.bytes);
        dictionaryIndexes.set(row.id, index);
      }
      const text = await mdict.lookup(row.bytes, index, wanted);
      if (text) return { status: "found", text, source: row.name };
    } catch (error) {
      // One broken bundle must not take the others down with it; the reader can
      // delete it from settings once the log says so.
      logger.warn("本地词典查询失败", { dictionary: row.name, error: String(error) });
    }
  }
  return rows.length > 0 ? { status: "missing" } : { status: "unavailable" };
}
