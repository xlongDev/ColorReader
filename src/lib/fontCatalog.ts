/**
 * The font catalogue: faces the reader adds with one click instead of a file.
 *
 * Nothing here ships with the app. There are two ways in, and which one an
 * entry takes is decided by its licence rather than by preference:
 *
 * - `CATALOG_FONTS` — SIL OFL 1.1 faces, installed from *stylesheets*. Each
 *   entry points at the `@font-face` rules hosted on a public CDN, and the
 *   glyph subsets they name stream per `unicode-range`, so the app never
 *   downloads the face: a section fetches the handful of subsets its own glyphs
 *   fall into. The cost of "installing" one is the sheet — a couple of hundred
 *   kilobytes, against the ten-or-twenty megabytes the face itself is.
 * - `CATALOG_FILES` — brand faces, installed from the *vendor's own archive*.
 *   Their agreements permit unmodified copies to travel with software but
 *   forbid redistributing the fonts on their own, so there is no mirror to
 *   point at, and subsetting one into a stylesheet would be the modification
 *   clause 2.2 forbids. The app reads the vendor's zip's own table of contents
 *   over a range request and fetches only the member it wants, so the copy on
 *   the reader's disk is the vendor's byte for byte — and the other 46 MB of the
 *   package is never asked for.
 *
 * 🔴 The `sha256` values were computed from the real bytes on 2026-10-14, not
 * hand-copied. `downloadCatalogFont` refuses a sheet that hashes otherwise, and
 * `font.install_catalog` refuses a member that does — those checks are the only
 * thing standing between a compromised host and the app silently adopting
 * someone else's glyphs, and they are pinned by `fontCatalog.test.ts` and
 * `font_archive.rs` against fixtures that hash the other way.
 */

import type { CatalogInstall, LocalFont } from "@/types/ipc";

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

/**
 * A face that arrives as a whole font file, out of the vendor's own archive.
 *
 * HarmonyOS Sans is here and not above because its agreement is the one that
 * permits this shape. It grants the right to "use, copy, merge, embed, bundle,
 * redistribute and/or sell **unmodified** copies" with any software, which is
 * what lets the app fetch Huawei's archive and unpack a face out of it — and
 * what makes the two conditions load-bearing. Clause 2.2 forbids modifying the
 * fonts or any component of them, so this entry must name Huawei's own zip:
 * the npm packages that subset it into a webfont (`harmonyos-sans-webfont-
 * splitted`, `@lobehub/webfont-harmony-sans`) are modified fonts and cannot be
 * used. Clause 2.3 forbids redistributing them "in a stand-alone base", which
 * is what a mirror of the raw files would be.
 *
 * MiSans is the counter-example and is deliberately absent: Xiaomi publishes it
 * only inside a 217 MB archive of nested zips, and its agreement forbids
 * passing the fonts on at all. No shape of this entry would be honest about
 * either.
 */
export interface CatalogFontFile {
  id: string;
  /** What the reader sees, in the picker and in the settings row. */
  name: string;
  /**
   * Where the archive is fetched from, in order — the first to answer wins.
   *
   * One source, unlike the sheet entries: there is exactly one place the vendor
   * publishes this, and a third-party copy would be the redistribution the
   * agreement forbids. A source that is down is a font that will not install
   * today, which is the honest outcome.
   */
  sources: string[];
  /** The member inside the archive that is the face. */
  member: string;
  /**
   * sha256 of the **member's** bytes, not the archive's.
   *
   * The member is what lands on disk, so the member is what gets pinned.
   * Pinning the archive instead would pin the download rather than the font,
   * and would break the install the day Huawei repacks the package — a new
   * `LICENSE.txt` inside it changes the zip and not the face.
   */
  sha256: string;
  /** The member's size — what the face costs on disk once installed. */
  bytes: number;
  /**
   * Roughly what installing costs over the network.
   *
   * Measured against the real archive, and the *only* figure here that is
   * approximate. The member's compressed size is the server's business and can
   * change the next time Huawei repacks the package, so nothing checks this —
   * what has to stay true is `sha256`, and that is pinned. A hint that drifts by
   * a few hundred kilobytes costs a slightly stale number in a sentence.
   */
  downloadBytes: number;
  /**
   * The whole archive's size — what the *fallback* route downloads.
   *
   * Only reached when the narrow route cannot be used: a server that ignores
   * `Range`, or a zip shape the reader's parser declines to guess at. It is not
   * what installing normally costs.
   */
  archiveBytes: number;
  /** The vendor's licence file inside the same archive. */
  licenseMember: string;
  license: string;
  licenseUrl: string;
  /**
   * The notice the agreement requires the *software* to carry.
   *
   * HarmonyOS Sans's clause 2.1: "YOU shall make a prominent notice in the
   * software to state that HarmonyOS Sans Fonts are used." The settings row
   * prints this verbatim, which is where that promise is kept — there is no
   * licences screen in the app for it to live on instead.
   */
  notice: string;
}

export const CATALOG_FILES: readonly CatalogFontFile[] = [
  {
    id: "harmonyos-sans",
    // The name the agreement uses, and the name in the font's own name table.
    // Worth keeping in English: the stored file is `<uuid>.ttf`, so this label
    // is the only thing on the reader's disk that still says whose font it is.
    name: "HarmonyOS Sans",
    sources: ["https://developer.huawei.com/images/download/general/HarmonyOS-Sans.zip"],
    member: "HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Regular.ttf",
    sha256: "297b088424be212207df2ce8b98e335468b782aa6b96832af0b8b773d711e2b1",
    bytes: 8_261_128,
    // The members (5,562,865 + 1,644 compressed) plus the archive's tail and its
    // 18 KB table of contents: what the narrow route actually moves. Measured,
    // not derived — see the field's own note on why it is allowed to be inexact.
    downloadBytes: 5_649_494,
    archiveBytes: 52_165_952,
    licenseMember: "HarmonyOS Sans/HarmonyOS_Sans_SC/LICENSE.txt",
    license: "HarmonyOS Sans Fonts License Agreement",
    licenseUrl: "https://developer.huawei.com/consumer/cn/design/resource/",
    notice: "本软件使用了 HarmonyOS Sans 字体。Copyright 2021 Huawei Device Co., Ltd.",
  },
];

/**
 * The install request for one archive entry — only what the backend needs.
 *
 * The pins travel with it, and that is not a hole: the catalogue is compiled
 * into the same signed bundle as the code that hands it over, and the check
 * itself has to happen where the bytes are. What the frontend cannot do is hold
 * the archive up against the hash — it has no zip reader and no filesystem.
 */
export function archiveRequest(font: CatalogFontFile): CatalogInstall {
  return {
    catalogId: font.id,
    name: font.name,
    sources: [...font.sources],
    member: font.member,
    sha256: font.sha256,
    licenseMember: font.licenseMember,
  };
}

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

/**
 * The imported fonts the 已导入 list still has to show.
 *
 * A catalogue face installed from an archive *is* an imported font, so without
 * this it would be listed twice — once as the entry, once as the file — and the
 * entry's row is the one carrying the licence and the download size.
 *
 * 🔴 Only the fonts a catalogue row is *actually rendering* are held back. An
 * entry retired from `CATALOG_FILES` leaves its font carrying an id nothing
 * matches, and hiding that one would put a face on the reader's disk with no row
 * anywhere to delete it from — the same dead end the reset path exists to avoid.
 * Keyed off what is in the catalogue now, never off "has a catalogue id".
 */
export function handImported(fonts: readonly LocalFont[]): LocalFont[] {
  const shown = new Set(CATALOG_FILES.map((font) => font.id));
  return fonts.filter((font) => !font.catalogId || !shown.has(font.catalogId));
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
