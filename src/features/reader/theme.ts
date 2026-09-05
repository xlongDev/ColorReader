/**
 * Reading surfaces and typefaces for the reading viewport.
 *
 * Surfaces are absolute (a reader may keep a paper surface while the app shell
 * follows the OS theme): every entry pairs a background with a foreground that
 * clears AA on it, so the picker can never produce an unreadable combination.
 * The custom surface reuses the day palette under a strong scrim for the same
 * reason: a user image must not decide text contrast.
 */

export interface ReadingSurface {
  key: string;
  label: string;
  /** CSS `background` for the reading viewport. */
  background: string;
  /** Body text color, contrast-checked against `background`. */
  fg: string;
}

export type PageTransition = "none" | "slide" | "fade" | "paper";
export type LayoutMode = "scroll" | "single" | "double";

export const READING_SURFACES: ReadingSurface[] = [
  { key: "standard", label: "标准", background: "#fbfbfd", fg: "#23272e" },
  { key: "sepia", label: "护眼", background: "#f4ecd8", fg: "#443c2c" },
  { key: "green", label: "绿色护眼", background: "#e4eee2", fg: "#2c3a2c" },
  { key: "night", label: "夜间", background: "#15181d", fg: "#c9ced8" },
  {
    key: "paper",
    label: "纸纹",
    background:
      "repeating-linear-gradient(0deg, rgba(120,90,40,0.035) 0px, rgba(120,90,40,0.035) 1px, transparent 1px, transparent 3px), #f7f3ea",
    fg: "#3f3a30",
  },
  {
    key: "linen",
    label: "亚麻",
    background:
      "repeating-linear-gradient(45deg, rgba(90,110,90,0.04) 0px, rgba(90,110,90,0.04) 2px, transparent 2px, transparent 6px), #eef0e9",
    fg: "#33382e",
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
    };
  }
  return READING_SURFACES.find((surface) => surface.key === key) ?? READING_SURFACES[0]!;
}

export interface FontOption {
  key: string;
  label: string;
  /** CSS `font-family` for the article body. */
  stack: string;
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
];

export function resolveFont(key: string): string {
  return (FONT_STACKS.find((font) => font.key === key) ?? FONT_STACKS[0]!).stack;
}

export const PAGE_TRANSITIONS: { key: PageTransition; label: string }[] = [
  { key: "none", label: "无" },
  { key: "slide", label: "左右平移" },
  { key: "fade", label: "淡入淡出" },
  { key: "paper", label: "仿真书页" },
];

export const LAYOUT_MODES: { key: LayoutMode; label: string }[] = [
  { key: "scroll", label: "滚动" },
  { key: "single", label: "单页" },
  { key: "double", label: "双页" },
];
