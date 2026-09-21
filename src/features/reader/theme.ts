/**
 * Reading surfaces and typefaces for the reading viewport.
 *
 * Surfaces are absolute (a reader may keep a paper surface while the app shell
 * follows the OS theme): every entry pairs a background with a foreground that
 * clears AA on it, so the picker can never produce an unreadable combination.
 * The custom surface reuses the day palette under a strong scrim for the same
 * reason: a user image must not decide text contrast.
 */

import type { CSSProperties } from "react";

import type { LocalFont } from "@/types/ipc";

export interface ReadingSurface {
  key: string;
  label: string;
  /** CSS `background` for the reading viewport. */
  background: string;
  /** Body text color, contrast-checked against `background`. */
  fg: string;
  /** Solid representative color for tinting the reader chrome (header,
   * footer, glass buttons) so the whole page reads as one material. */
  tint: string;
  /** Which app chrome palette pairs with this surface while reading. */
  mode: "light" | "dark";
}

export type PageTransition = "none" | "pan" | "slide" | "fade" | "paper";
export type LayoutMode = "scroll" | "single" | "double";

export const READING_SURFACES: ReadingSurface[] = [
  {
    key: "standard",
    label: "标准",
    background: "#fbfbfd",
    fg: "#23272e",
    tint: "#f4f5f8",
    mode: "light",
  },
  {
    key: "sepia",
    label: "护眼",
    background: "#f4ecd8",
    fg: "#443c2c",
    tint: "#f2e9d2",
    mode: "light",
  },
  {
    key: "green",
    label: "绿色",
    background: "#e4eee2",
    fg: "#2c3a2c",
    tint: "#e2ecdf",
    mode: "light",
  },
  {
    key: "mist",
    label: "雾蓝",
    background: "#e9eef5",
    fg: "#2b3440",
    tint: "#e8edf4",
    mode: "light",
  },
  {
    key: "blush",
    label: "霞粉",
    background: "#f6ebe8",
    fg: "#40302c",
    tint: "#f4e9e6",
    mode: "light",
  },
  {
    key: "dusk",
    label: "暮紫",
    background: "#edeaf3",
    fg: "#332e3e",
    tint: "#ebe8f1",
    mode: "light",
  },
  {
    key: "night",
    label: "夜间",
    background: "#15181d",
    fg: "#c9ced8",
    tint: "#181c23",
    mode: "dark",
  },
  {
    key: "pine",
    label: "松烟",
    background: "#1b231e",
    fg: "#c5d1c8",
    tint: "#1e2620",
    mode: "dark",
  },
  {
    key: "indigo",
    label: "黛蓝",
    background: "#131a26",
    fg: "#c3cbd9",
    tint: "#161d29",
    mode: "dark",
  },
  {
    key: "void",
    label: "玄黑",
    background: "#0e1013",
    fg: "#c6cad2",
    tint: "#111317",
    mode: "dark",
  },
  {
    key: "paper",
    label: "纸纹",
    background:
      "repeating-linear-gradient(0deg, rgba(120,90,40,0.035) 0px, rgba(120,90,40,0.035) 1px, transparent 1px, transparent 3px), #f7f3ea",
    fg: "#3f3a30",
    tint: "#f5f1e7",
    mode: "light",
  },
  {
    key: "linen",
    label: "亚麻",
    background:
      "repeating-linear-gradient(45deg, rgba(90,110,90,0.04) 0px, rgba(90,110,90,0.04) 2px, transparent 2px, transparent 6px), #eef0e9",
    fg: "#33382e",
    tint: "#edefe7",
    mode: "light",
  },
];

/** Day palette applied under the custom image scrim. */
const CUSTOM_SURFACE_FG = "#23272e";
/** White veil over user images; keeps body text at standard-surface contrast. */
const CUSTOM_SURFACE_SCRIM = "rgba(251,251,253,0.88)";

export function resolveSurface(key: string, customImage: string | null): ReadingSurface {
  if (key === "custom" && customImage) {
    return {
      key: "custom",
      label: "自定义",
      background: `linear-gradient(${CUSTOM_SURFACE_SCRIM}, ${CUSTOM_SURFACE_SCRIM}), url("${customImage}") center / cover no-repeat`,
      fg: CUSTOM_SURFACE_FG,
      tint: "#f4f5f8",
      mode: "light",
    };
  }
  return READING_SURFACES.find((surface) => surface.key === key) ?? READING_SURFACES[0]!;
}

/** Re-roots the glass token set on a reading surface: chrome styled from these
 *  derives its ink, hairlines and glass fills from the same paper colours as
 *  the reading viewport, so everything reads as one material. Ratios mirror
 *  the theme defaults in globals.css. */
export function readerGlassVars(surface: ReadingSurface): CSSProperties {
  return {
    "--text-1": surface.fg,
    "--text-2": `color-mix(in srgb, ${surface.fg} 72%, transparent)`,
    "--text-3": `color-mix(in srgb, ${surface.fg} 60%, transparent)`,
    "--hairline": `color-mix(in srgb, ${surface.fg} 12%, transparent)`,
    "--hairline-strong": `color-mix(in srgb, ${surface.fg} 24%, transparent)`,
    "--surface-1": `color-mix(in srgb, ${surface.fg} 5%, transparent)`,
    "--surface-2": `color-mix(in srgb, ${surface.fg} 9%, transparent)`,
    "--surface-3": `color-mix(in srgb, ${surface.tint} 96%, ${surface.fg})`,
    // Chrome buttons fill with the paper colour (not the ink), so floating
    // controls read as clear glass instead of a dark ink wash on the page.
    "--glass-btn": `color-mix(in srgb, ${surface.tint} 82%, transparent)`,
  } as CSSProperties;
}

export interface FontOption {
  key: string;
  label: string;
  /** CSS `font-family` for the article body. */
  stack: string;
  /**
   * The `font-family` this option's `@font-face` is declared under in the *app*
   * document, when the face ships with the app rather than being imported.
   *
   * It has to be named here because a book section cannot see the app's own
   * declarations (see [`bundledFontFaces`]), and the stack alone is not enough
   * to go on: it lists four families, only the first of which is bundled.
   */
  bundled?: string;
}

export const FONT_STACKS: FontOption[] = [
  { key: "system", label: "系统", stack: "var(--font-sans)" },
  { key: "song", label: "宋体", stack: '"Songti SC", "STSong", "SimSun", Georgia, serif' },
  { key: "kai", label: "楷体", stack: '"Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", serif' },
  {
    key: "hei",
    label: "黑体",
    stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  // 霞鹜文楷 — the `@font-face` ships with the app (see `main.tsx`), so
  // the reader can pick it without the user having to import a font. Falls
  // back to the system kaiti stack on the rare platform without LXGW.
  {
    key: "lxgw",
    label: "霞鹜文楷",
    stack: '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", "KaiTi", serif',
    bundled: "LXGW WenKai",
  },
];

/**
 * An imported font is selected as `custom:<id>` and declared in CSS as
 * `cr-<id>`. Both names come from the id alone, which is what keeps
 * [`resolveFont`] a pure function of the stored settings value: the picker has
 * the list of imported fonts, the style builders do not.
 */
const CUSTOM_FONT = "custom:";
const CUSTOM_FAMILY = "cr-";

/** The settings key that selects an imported font. */
export function customFontKey(id: string): string {
  return `${CUSTOM_FONT}${id}`;
}

/** The `font-family` an imported font is declared and used under. */
export function customFontFamily(id: string): string {
  return `${CUSTOM_FAMILY}${id}`;
}

export function resolveFont(key: string): string {
  if (key.startsWith(CUSTOM_FONT)) {
    // Quoted: a uuid is not a valid bare family name, and an unquoted one makes
    // the whole declaration invalid rather than merely wrong.
    return `"${customFontFamily(key.slice(CUSTOM_FONT.length))}"`;
  }
  return (FONT_STACKS.find((font) => font.key === key) ?? FONT_STACKS[0]!).stack;
}

/**
 * `@font-face` for the fonts the reader imported.
 *
 * Each document needs its own copy: a book section is a document of its own, so
 * neither the app's declarations nor another section's reach into it. Taking
 * ids and urls rather than whole records lets the picker build the same rules
 * without the list the reader page holds.
 *
 * `font-display: swap` is load-bearing, not decoration: an imported CJK face
 * can be twenty megabytes, and the alternative is a page of invisible text
 * while it arrives. The URL is the resource protocol's — the backend builds it
 * because the origin depends on the platform the app was compiled for.
 */
export function fontFaceCss(fonts: readonly Pick<LocalFont, "id" | "url">[]): string {
  return fonts
    .map(
      (font) =>
        `@font-face { font-family: "${customFontFamily(font.id)}"; src: url("${font.url}"); font-display: swap; }`,
    )
    .join("\n");
}

/**
 * `@font-face` for a face that ships with the app, read back out of the app's
 * own stylesheets so a book section can carry a copy.
 *
 * The bug this exists for: 霞鹜文楷 is installed in the app document (`main.tsx`
 * imports the webfont package's 582 `unicode-range` subsets), and a foliate
 * section is a document of its own. A section asking for `"LXGW WenKai"` finds
 * no such face in *its* document, falls through the stack, and renders as
 * `"Kaiti SC"` — the reader picks 霞鹜文楷 and gets the system 楷体. The rules
 * have to be handed to the section, which is the same thing `fontFaceCss`
 * already does for imported faces.
 *
 * Reading them back rather than importing the package's CSS a second time
 * keeps one copy of the 29 MB of subsets in the build: the URLs in these rules
 * are the ones Vite already emitted for the app's own sheet. They are resolved
 * against the sheet they came from, because in a production build the sheet is
 * a hashed `/assets/*.css` and its `src` is relative to *that*, not to the
 * page.
 *
 * Only the weights a book's body text uses. The package also ships 300 and a
 * monospace cut; carrying those would add ~320 KB of rules to every section
 * document for nothing. Measured cost of the remaining 194 rules: ~2 ms to
 * inject into a document, and only the handful of subsets the section's own
 * glyphs fall into are ever fetched.
 */
export function bundledFontFaces(
  family: string,
  weights: readonly string[] = ["400", "700"],
): string {
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      // A cross-origin sheet cannot be read. Everything the app ships is
      // same-origin, so this is only ever a third party's.
      continue;
    }
    for (const rule of cssRules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const declared = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      if (declared !== family) continue;
      if (!weights.includes(rule.style.getPropertyValue("font-weight"))) continue;
      rules.push(
        withBlockDisplay(rule.cssText).replace(
          /url\((["']?)([^"')]+)\1\)/g,
          (_match, _quote: string, url: string) =>
            `url("${new URL(url, sheet.href ?? document.baseURI).href}")`,
        ),
      );
    }
  }
  return rules.join("\n");
}

/**
 * The same face, held back until it has arrived instead of swapping in late.
 *
 * The webfont package authors all 582 subsets with `font-display: swap`, which
 * is the right default for a page that can afford a fallback and the wrong one
 * here: a reader switching to 霞鹜文楷 watches the book render in 楷体 — the
 * next family in the stack — for as long as the subsets take to arrive, and
 * then change under them. That flash is what "只是变成了楷体" looked like.
 *
 * `block` spends the same moment showing *nothing* rather than the wrong face.
 * It is a short moment: the subsets are served out of the app bundle, a section
 * only ever needs the handful its own glyphs fall into, and the rules are
 * injected before the section paints — so the reader sees the text arrive
 * already in the font they chose.
 *
 * The app document gets the same treatment at the build layer (`vite.config.ts`
 * rewrites the package's CSS), because a `.txt` book renders there rather than
 * in a foliate section, and it flashed for exactly the same reason.
 */
function withBlockDisplay(css: string): string {
  return /font-display\s*:/.test(css)
    ? css.replace(/font-display\s*:\s*[a-z]+/i, "font-display: block")
    : css.replace(/\{\s*/, "{ font-display: block; ");
}

/** The bundled `@font-face` rules a font key needs inside a book section, or
 *  an empty string for every face the app does not ship itself. */
export function bundledFacesFor(key: string): string {
  const family = FONT_STACKS.find((font) => font.key === key)?.bundled;
  return family ? bundledFontFaces(family) : "";
}

export const PAGE_TRANSITIONS: { key: PageTransition; label: string }[] = [
  { key: "none", label: "无" },
  { key: "pan", label: "左右平移" },
  { key: "slide", label: "覆盖" },
  { key: "fade", label: "淡入淡出" },
  { key: "paper", label: "仿真" },
];

export const LAYOUT_MODES: { key: LayoutMode; label: string }[] = [
  { key: "scroll", label: "滚动" },
  { key: "single", label: "单页" },
  { key: "double", label: "双页" },
];
