/**
 * The font catalogue: faces the reader adds with one click instead of a file.
 *
 * Nothing here ships with the app, and every entry takes the same way in: an
 * SIL OFL 1.1 face installed from a *stylesheet*. An entry points at the
 * `@font-face` rules hosted on a public CDN, and the glyph subsets they name
 * stream per `unicode-range`, so the app never downloads the face — a section
 * fetches the handful of subsets its own glyphs fall into. The cost of
 * "installing" one is the sheet, a couple of hundred kilobytes, against the
 * ten-or-twenty megabytes the face itself is.
 *
 * 🔴 **A second kind lived here until 2026-10-16, and it is gone.** Brand faces
 * whose agreement permits unmodified copies to travel with software but forbids
 * redistributing the fonts on their own used to arrive out of the *vendor's own
 * archive* (`CATALOG_FILES`): the app read the zip's table of contents over a
 * range request and fetched only the member it wanted, so the copy on the
 * reader's disk was the vendor's byte for byte. HarmonyOS Sans was the only
 * entry, and the whole path went with it — the entry, the Rust archive reader,
 * the range stitching, and the `font.install_catalog` command. A face that
 * arrives as a whole file has one way in now, the same as any other: 导入字体.
 * Re-adding a brand face means building that path again, not adding an entry.
 *
 * 🔴 The `sha256` values were computed from the real bytes on 2026-10-14 — and
 * on 2026-10-16 for 寒蝉正楷体 — not hand-copied. `downloadCatalogFont` refuses
 * a sheet that hashes otherwise, and that check is the only thing standing
 * between a compromised host and the app silently adopting someone else's
 * glyphs; it is pinned by `fontCatalog.test.ts` against a fixture that hashes
 * the other way.
 */

/** One stylesheet: where it lives, what it must hash to, what it costs. */
export interface CatalogSheet {
  /** The CSS `font-weight` this sheet serves. */
  weight: string;
  /**
   * Where the sheet can be fetched from, in order — the first to answer wins.
   *
   * Two sources, not one: a CDN outage is a font that will not install, and
   * the app has no way to route around it from its side. Both hosts serve the
   * same package version, so either answering is the same bytes.
   */
  sources: string[];
  /** sha256 of the sheet's bytes, lowercase hex. */
  sha256: string;
  /** The sheet's size in bytes — what installing costs before any glyph. */
  bytes: number;
}

export interface CatalogFont {
  id: string;
  /** What the reader sees: in the settings row and the picker alike. */
  name: string;
  /**
   * The `font-family` the sheet declares its faces under. A book section
   * cannot see the app's own declarations, so the face travels into the
   * section under this name (see `adoptedFontFaces`).
   */
  family: string;
  /** The picker's stack: the family first, then what to fall through to. */
  stack: string;
  /**
   * Rendered with this key while the sheet is in flight — the family the
   * stack falls through to, so the frame looks like the finished thing
   * rather than like a change. Same reasoning as 霞鹜文楷's `kai`.
   */
  fallbackKey: string;
  sheets: CatalogSheet[];
  license: string;
  licenseUrl: string;
}

export const CATALOG_FONTS: readonly CatalogFont[] = [
  {
    id: "lxgw",
    name: "霞鹜文楷",
    family: "LXGW WenKai",
    stack: '"LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", serif',
    fallbackKey: "kai",
    sheets: [
      {
        weight: "400",
        sources: [
          "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css",
          "https://unpkg.com/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css",
        ],
        sha256: "05878e854d5bfee18bc92ff6c5b85b3fd8ea10e3960a839423ff905d7df2b56f",
        bytes: 105_359,
      },
      {
        weight: "700",
        sources: [
          "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-bold.css",
          "https://unpkg.com/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-bold.css",
        ],
        sha256: "c106df711132207863f25e23e9732316f2807b0501c58786ea99a4ea072de8fd",
        bytes: 105_068,
      },
    ],
    license: "SIL OFL 1.1",
    licenseUrl: "https://github.com/lxgw/LxgwWenKai",
  },
  {
    id: "noto-serif-sc",
    /**
     * 思源宋体 first, because this entry *is* 思源宋体: Google publishes Adobe's
     * Source Han Serif under the Noto Serif CJK name, and the bytes say so —
     * the faces in the pinned sheet carry Adobe's copyright and
     * `Version 2.003`, which is the version `adobe-fonts/source-han-serif`
     * currently ships. A reader looking for the name they know should find it
     * here rather than meet a second entry holding the same outlines.
     *
     * `family` stays Google's, and must: that is the name the sheet declares
     * and the one `adoptedFontFaces` matches a rule on.
     */
    name: "思源宋体 / Noto Serif SC",
    family: "Noto Serif SC",
    stack: '"Noto Serif SC", "Songti SC", "STSong", "SimSun", serif',
    fallbackKey: "song",
    sheets: [
      {
        weight: "400",
        sources: [
          "https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.1/400.css",
          "https://unpkg.com/@fontsource/noto-serif-sc@5.3.1/400.css",
        ],
        sha256: "1e6d71ac129b98db3fcc64da23c7d8ec696e16a184d4a5eacff63d25dfd7e3e2",
        bytes: 105_678,
      },
      {
        weight: "700",
        sources: [
          "https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.1/700.css",
          "https://unpkg.com/@fontsource/noto-serif-sc@5.3.1/700.css",
        ],
        sha256: "7a0c2f9452a758223dc3d3f1e6346369802f3cf06976383147d9bc0a17297fa7",
        bytes: 105_678,
      },
    ],
    license: "SIL OFL 1.1",
    licenseUrl: "https://github.com/notofonts/noto-cjk",
  },
  {
    id: "chill-kai",
    name: "寒蝉正楷体",
    /** The family the sheet declares, which is also the font's own PostScript
     *  name (`ChillKai`, 寒蝉字型). */
    family: "ChillKai",
    /**
     * 楷体's stack with the face in front — the same reasoning as 霞鹜文楷's:
     * while the sheet is in flight the reader sees the system 楷体 rather than
     * a serif that changes under them a moment later.
     */
    stack: '"ChillKai", "Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", serif',
    fallbackKey: "kai",
    /**
     * One sheet, because ChillKai has one weight: v2.000 ships Regular and
     * nothing else, and a second entry here would be a weight the font does not
     * have. Body bold falls back to the webview's synthesis, as it does for
     * every other single-face path (see the note in `library.md`).
     *
     * ⚠️ **The source is a community repackage, not the author's own bytes.**
     * `Warren2060/Chillkai` deleted the font from the repository — its last
     * commit is literally "Delete ChillKai directory", the tree holds only
     * `LICENSE` and `README.md`, and the v2.000 release carries no assets. So
     * the author publishes no copy at all, and this community repackage is the
     * only one there is.
     *
     * What makes the entry legitimate is still the licence, and it is upstream's:
     * SIL OFL 1.1 permits redistribution and modification, and this package
     * declares the same. What the pin does *not* establish is that these are the
     * author's outlines — `sha256` covers the sheet, not the 385 glyph subsets
     * it names, which the browser fetches from the same CDN unpinned. That is
     * true of every sheet entry here; this is the only one whose publisher is a
     * third party, and the licence is what makes that acceptable rather than
     * merely convenient.
     *
     * One more difference from the other two packages, and the only one that
     * changes what actually renders: all 385 rules here are authored
     * `src: local("ChillKai"), url(…)`, so a reader who has ChillKai installed
     * on their own machine gets *their* copy rather than the pinned subset.
     * Neither of the other two names a `local()`. Nothing breaks — the face is
     * ChillKai either way, and a reader who installed it themselves chose it —
     * but this is the one entry whose glyphs the pin does not decide.
     */
    sheets: [
      {
        weight: "400",
        sources: [
          "https://cdn.jsdelivr.net/npm/@xiao-xue-seng/chill-kai@1.0.0/result.css",
          "https://unpkg.com/@xiao-xue-seng/chill-kai@1.0.0/result.css",
        ],
        sha256: "bce7308ea5944b513c0ee07c9c5b63bbc0deab800b688d562d229df789905db5",
        bytes: 188_738,
      },
    ],
    license: "SIL OFL 1.1",
    licenseUrl: "https://github.com/Warren2060/Chillkai",
  },
];

/** The prefix a catalogue font is stored as in the reader's font key. */
export const CATALOG_KEY_PREFIX = "catalog:";

export function catalogKey(id: string): string {
  return `${CATALOG_KEY_PREFIX}${id}`;
}

/** The catalogue id a font key selects, or `null` for every other key.
 *
 *  The bare prefix selects nothing: `catalog:` on its own would otherwise
 *  answer `""`, an id no entry can have, and every lookup built on it would
 *  miss rather than take the "not a catalogue font" branch it belongs in. */
export function catalogIdOfKey(key: string): string | null {
  if (!key.startsWith(CATALOG_KEY_PREFIX)) return null;
  const id = key.slice(CATALOG_KEY_PREFIX.length);
  return id === "" ? null : id;
}

export function catalogFontById(id: string): CatalogFont | null {
  return CATALOG_FONTS.find((font) => font.id === id) ?? null;
}

export function catalogFontOfKey(key: string): CatalogFont | null {
  const id = catalogIdOfKey(key);
  return id === null ? null : catalogFontById(id);
}

/** What the sheets weigh together, in bytes — the install cost, not the font. */
export function catalogSheetBytes(font: CatalogFont): number {
  return font.sheets.reduce((total, sheet) => total + sheet.bytes, 0);
}

const URL_IN_CSS = /url\((['"]?)([^'")]+)\1\)/g;

/**
 * Makes every relative `url()` in a fetched sheet absolute.
 *
 * The sheets name their subsets relatively (`./files/….woff2`), which resolves
 * against the sheet's own URL when the browser fetches it over HTTP — but the
 * app adopts the sheet as an inline `<style>`, where there is no sheet URL to
 * resolve against and every subset 404s. Rewriting against the source the
 * bytes actually came from is the same resolution the browser would have done,
 * done once, up front.
 */
export function rewriteSheetUrls(css: string, sheetUrl: string): string {
  const base = sheetUrl.slice(0, sheetUrl.lastIndexOf("/") + 1);
  return css.replace(URL_IN_CSS, (match, _quote: string, url: string) =>
    /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url) ? match : `url("${new URL(url, base).href}")`,
  );
}

/** sha256 of raw bytes, lowercase hex. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether bytes are exactly the sheet the catalogue pinned. */
export async function sheetMatches(bytes: ArrayBuffer, expected: string): Promise<boolean> {
  return (await sha256Hex(bytes)) === expected.toLowerCase();
}
