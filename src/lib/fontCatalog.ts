/**
 * The font catalogue: faces the reader adds with one click instead of a file.
 *
 * Nothing here ships with the app. Each entry points at *stylesheets* — the
 * `@font-face` rules — hosted on a public CDN, and the glyph subsets they name
 * stream per `unicode-range`, so the app never downloads the face: a section
 * fetches the handful of subsets its own glyphs fall into. The cost of
 * "installing" a catalogue font is the sheet — a couple of hundred kilobytes,
 * against the ten-or-twenty megabytes the face itself is.
 *
 * Two entries, both SIL OFL 1.1 — the licences that permit serving the bytes
 * from our own mirror in the first place. The brand faces (HarmonyOS Sans,
 * MiSans, and the two the reader dropped) are deliberately absent: their
 * agreements either forbid third-party download channels outright or forbid
 * redistributing the font files, which is what a CDN copy is. When they join
 * the catalogue they will point at the vendor's own URL, and carry the notice
 * their agreement requires us to show.
 *
 * 🔴 The `sha256` values were computed from the real bytes on 2026-10-14, not
 * hand-copied. `downloadCatalogFont` refuses a sheet that hashes otherwise —
 * that check is the only thing standing between a CDN compromise and the app
 * silently adopting someone else's glyphs, and it is pinned by
 * `catalogFont.test.ts` against a hash-mismatch fixture.
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
    name: "Noto Serif SC",
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
