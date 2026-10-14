/**
 * Catalogue fonts at runtime: fetch, verify, adopt — and keep.
 *
 * A catalogue font enters the app as one inline `<style>` per font, holding
 * every weight's sheet. That shape is chosen over the two obvious ones:
 *
 * - A `<link href="https://cdn…">` is cross-origin, and a cross-origin
 *   stylesheet's `cssRules` cannot be read — `adoptedFontFaces` walks exactly
 *   that, and would answer "this build has no such face" for a face the
 *   reader just installed.
 * - A blob URL has no base to resolve the sheets' relative subset URLs
 *   against.
 *
 * An inline `<style>` is same-origin, readable, and its URLs are absolute by
 * the time they land (see `rewriteSheetUrls`), so `adoptedFontFaces` copies
 * the rules into a book section unchanged.
 *
 * 🔴 The adopted sheet is also written to `localStorage` (`SHEET_STORE`), and
 * that copy is what an installed font is *made of*. The rules are the whole of
 * what this path needs from the CDN, so re-fetching them on every launch meant
 * a font the reader had installed disappeared entirely — every glyph of it,
 * not a subset — the moment the network was not there.
 *
 * The **glyph subsets** are still the browser's to cache. It fetches only the
 * ones a book's text falls into, and the webview's HTTP cache holds them, so a
 * book already read comes back whole offline; a subset never fetched falls back
 * per glyph. Carrying every subset locally instead would be 28.5 MB for 霞鹜文楷
 * and ~18 MB for Noto Serif SC — the size this catalogue exists to avoid.
 *
 * The reader path (`ensureCatalogAdopted`) and the settings path
 * (`downloadCatalogFont`) are the same code: the settings flag only decides
 * whether the font is *offered*, never where the bytes come from.
 */

import { rewriteSheetUrls, sheetMatches, type CatalogFont } from "@/lib/fontCatalog";
import { withBlockDisplay } from "@/features/reader/theme";

/** Every catalogue `<style>` in the document carries this id prefix. */
const STYLE_ID_PREFIX = "catalog-font-";

/** The `<style>` element a catalogue font is adopted into, keyed by font id. */
function styleId(id: string): string {
  return `${STYLE_ID_PREFIX}${id}`;
}

/**
 * Where the adopted sheets are kept between sessions.
 *
 * Its own `localStorage` key rather than a field in the settings store: that
 * store is written on every preference change — a slider drag is a write per
 * frame — and zustand serialises the whole of it each time, so a couple of
 * hundred kilobytes of CSS in there would make every one of those writes cost
 * that much string. This is cache, not preference, and it is touched only when
 * a font is installed, removed or adopted.
 *
 * It is the app's own storage on the reader's machine, so the sheet in it is
 * trusted the way the settings that select the font are. `sha256` guards the
 * *network* — a compromised CDN — and is not a defence against someone who can
 * already edit this app's state.
 */
const SHEET_STORE = "colorreader.catalogFontSheets";

interface StoredSheet {
  /** Which bytes this was built from — see `fingerprintOf`. */
  fingerprint: string;
  /** The sheet as adopted: URLs absolute, `font-display` rewritten. */
  css: string;
}

/** One host's answer: the bytes, and where they came from. */
interface FetchedSheet {
  bytes: ArrayBuffer;
  url: string;
}

/**
 * What identifies the bytes a stored sheet was built from.
 *
 * The manifest's own sha256 list, so a package bump or a corrected pin in
 * `fontCatalog.ts` invalidates the copy instead of leaving the app rendering
 * from bytes it would now refuse to fetch.
 */
function fingerprintOf(font: CatalogFont): string {
  return font.sheets.map((sheet) => sheet.sha256).join(" ");
}

/** Whether a parsed store entry is the shape `storeSheet` writes. */
function isStoredSheet(value: unknown): value is StoredSheet {
  if (typeof value !== "object" || value === null) return false;
  const { fingerprint, css } = value as Partial<StoredSheet>;
  return typeof fingerprint === "string" && typeof css === "string" && css !== "";
}

/** The whole store. Anything unreadable in it reads as an empty one: a
 *  half-written or hand-edited entry must not take the app down with it. */
function readStore(): Record<string, StoredSheet> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SHEET_STORE);
  } catch {
    // Storage disabled. Every font is fetched and adopted for this session and
    // none of them outlive it — which is what the app did before this existed.
    return {};
  }
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredSheet>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, StoredSheet>): void {
  try {
    localStorage.setItem(SHEET_STORE, JSON.stringify(store));
  } catch {
    // Out of quota, or storage disabled. The font is installed for this
    // session either way; only the next launch has to fetch again.
  }
}

/** The stored sheet for this font, if it is still the one the manifest asks
 *  for. */
function storedSheet(font: CatalogFont): string | null {
  const entry: unknown = readStore()[font.id];
  return isStoredSheet(entry) && entry.fingerprint === fingerprintOf(font) ? entry.css : null;
}

/** Keeps the adopted sheet for the next launch. */
function storeSheet(font: CatalogFont, css: string): void {
  writeStore({ ...readStore(), [font.id]: { fingerprint: fingerprintOf(font), css } });
}

/** Drops one font's copy — the store half of 删除. */
function forgetStoredSheet(id: string): void {
  const store = readStore();
  delete store[id];
  writeStore(store);
}

/**
 * The first source that answers, or the last error.
 *
 * Sources are tried in order and the first to answer wins — not the first to
 * *succeed at the status code*, which is why a non-2xx is thrown rather than
 * returned: a 404 from one CDN is a reason to ask the next, not to adopt
 * someone else's bytes.
 *
 * Sequential on purpose, and written as a recursion rather than a `for` loop
 * to say so: the linter reads `await` inside a loop as a `Promise.all` that
 * was never written, and here that rewrite is exactly the bug. Asking both
 * CDNs at once would hit the fallback host on every install — including the
 * ones where the first source answered — and a race would decide which bytes
 * the sheet came from instead of the declared order.
 */
async function fetchSheetBytes(sources: readonly string[]): Promise<FetchedSheet> {
  const [url, ...rest] = sources;
  if (url === undefined) throw new Error("字体样式表没有可用的下载源");
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { bytes: await response.arrayBuffer(), url };
  } catch (error) {
    if (rest.length === 0) {
      // The message is what the settings row shows, so the last failure is
      // spelled out; `cause` keeps the original stack for the console.
      throw new Error(`字体样式表所有源都取不到（最后：${String(error)}）`, { cause: error });
    }
    return fetchSheetBytes(rest);
  }
}

/**
 * Fetches every sheet of a catalogue font, verifies each against the pinned
 * hash, and adopts the whole face — or nothing.
 *
 * The hash check is the point. A sheet that does not match is refused before
 * anything is adopted, so a compromised or substituted CDN copies shows up as
 * a failed download rather than as a silently wrong 楷体. All-or-nothing by
 * the same logic: a face whose regular weight verified and whose bold did not
 * would render half of itself in a fallback nobody asked for.
 *
 * Returns the bytes fetched, so the caller has something honest to report —
 * `0` when the sheet came out of `SHEET_STORE` instead.
 */
export async function downloadCatalogFont(font: CatalogFont): Promise<number> {
  if (isCatalogAdopted(font.id)) return 0;

  // The stored copy first, and the network only if there is none. This is what
  // makes an installed font survive a restart, and work with the CDN gone.
  const stored = storedSheet(font);
  if (stored !== null) {
    adoptCatalogFont(font.id, stored);
    return 0;
  }

  // The weights are fetched together — two independent files, and a book needs
  // both before it can render at all, so there is nothing to serialise.
  // `Promise.all` keeps the order, so the adopted rules read regular-then-bold
  // whichever answered first.
  const sheets = await Promise.all(
    font.sheets.map(async (sheet) => {
      const { bytes, url } = await fetchSheetBytes(sheet.sources);
      if (!(await sheetMatches(bytes, sheet.sha256))) {
        throw new Error(`「${font.name}」的样式表校验失败（${url}）`);
      }
      // Absolute subset URLs first, then the same `swap` → `block` rewrite the
      // section path applies: a reader who just picked a font should watch the
      // text arrive in it, not arrive in 楷体 and change.
      return {
        bytes: bytes.byteLength,
        css: withBlockDisplay(rewriteSheetUrls(new TextDecoder().decode(bytes), url)),
      };
    }),
  );

  const css = sheets.map((sheet) => sheet.css).join("\n");
  adoptCatalogFont(font.id, css);
  storeSheet(font, css);
  return sheets.reduce((total, sheet) => total + sheet.bytes, 0);
}

/** The reader path: the face, adopted if this session has not done it yet. */
export async function ensureCatalogAdopted(font: CatalogFont): Promise<void> {
  await downloadCatalogFont(font);
}

/** Whether the face is currently adopted in this document. */
export function isCatalogAdopted(id: string): boolean {
  return document.getElementById(styleId(id)) !== null;
}

/** Puts (or replaces) the face's `<style>` in the app document. */
export function adoptCatalogFont(id: string, css: string): void {
  let style = document.getElementById(styleId(id)) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = styleId(id);
    document.head.append(style);
  }
  style.textContent = css;
}

/** Takes the face's `<style>` back out, and its stored copy with it — what
 *  删除 does. */
export function removeCatalogFont(id: string): void {
  document.getElementById(styleId(id))?.remove();
  forgetStoredSheet(id);
}

/**
 * Takes every catalogue font back out of the document and out of the store —
 * what 重置设置 does.
 *
 * `downloadedFonts` is a preference and lives in the settings store, so a
 * reset clears it; the sheets have to go with it. A family left declared in
 * the document with nothing in the settings to explain it is exactly the state
 * the settings row exists to make impossible. Nothing is lost — the sheets are
 * re-downloadable.
 */
export function forgetCatalogFonts(): void {
  for (const style of document.querySelectorAll(`style[id^="${STYLE_ID_PREFIX}"]`)) {
    style.remove();
  }
  try {
    localStorage.removeItem(SHEET_STORE);
  } catch {
    // Storage disabled: there is nothing stored to forget.
  }
}
