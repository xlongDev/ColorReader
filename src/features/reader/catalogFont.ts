/**
 * Catalogue fonts at runtime: fetch, verify, adopt.
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
 * The reader path (`ensureCatalogAdopted`) and the settings path
 * (`downloadCatalogFont`) are the same code: the settings flag only decides
 * whether the font is *offered*, never where the bytes come from. What that
 * costs is one sheet fetch per session per font, which the webview's HTTP
 * cache almost always absorbs — a local cache of the sheets themselves is a
 * phase-two question, not a phase-one assumption.
 */

import { rewriteSheetUrls, sheetMatches, type CatalogFont } from "@/lib/fontCatalog";
import { withBlockDisplay } from "@/features/reader/theme";

/** The `<style>` element a catalogue font is adopted into, keyed by font id. */
function styleId(id: string): string {
  return `catalog-font-${id}`;
}

/** One host's answer: the bytes, and where they came from. */
interface FetchedSheet {
  bytes: ArrayBuffer;
  url: string;
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
 * Returns the bytes adopted, so the caller has something honest to report.
 */
export async function downloadCatalogFont(font: CatalogFont): Promise<number> {
  if (isCatalogAdopted(font.id)) return 0;

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
      // build layer applies to the bundled sheet: a reader who just picked a
      // font should watch the text arrive in it, not arrive in 楷体 and change.
      return {
        bytes: bytes.byteLength,
        css: withBlockDisplay(rewriteSheetUrls(new TextDecoder().decode(bytes), url)),
      };
    }),
  );

  adoptCatalogFont(font.id, sheets.map((sheet) => sheet.css).join("\n"));
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

/** Takes the face's `<style>` back out — what 删除 does to the document. */
export function removeCatalogFont(id: string): void {
  document.getElementById(styleId(id))?.remove();
}
