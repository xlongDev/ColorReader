/**
 * The read-aloud wash as a value: which shape it draws, and in what ink.
 *
 * One module for all three rendering paths, because the marker has to read the
 * same whichever format is speaking: the prose path paints a `<mark>`, the
 * Kindle path an SVG group inside foliate's overlayer, and the PDF path a
 * `::highlight` rule. Only the last two have their own idea of how a colour
 * arrives, and both differences are handled here rather than in the callers.
 *
 * The colour arithmetic is deliberately `selection.ts::inkWash` — the same one
 * the reader's own annotations go through, so a wash and a highlight of the
 * same hex are the same ink.
 */
import type { CSSProperties } from "react";

import { inkWash } from "./selection";

/** The shapes readest offers, in picker order. */
export type TtsWashStyle = "highlight" | "underline" | "strikethrough" | "squiggly" | "outline";

export const TTS_WASH_STYLES: { key: TtsWashStyle; label: string }[] = [
  { key: "highlight", label: "荧光笔" },
  { key: "underline", label: "下划线" },
  { key: "strikethrough", label: "删除线" },
  { key: "squiggly", label: "波浪线" },
  { key: "outline", label: "轮廓" },
];

/** `null` is a real choice, not "unset": it means the app's own tint. */
export type TtsWashColor = string | null;

/**
 * A hex a reader typed, in the form the renderers want, or `null` when it is
 * not a colour yet.
 *
 * The leading `#` is optional and three digits expand the way CSS expands them:
 * a field that refuses `56aee2` because it wanted `#56aee2` is a field that gets
 * in the way. Everything that survives comes back lowercase, so two spellings
 * of one ink compare equal — the pinned-colours list and the "is this one
 * already in the row" check both lean on that.
 */
export function parseWashHex(text: string): string | null {
  const value = text.trim().replace(/^#/, "").toLowerCase();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(value)) return null;
  const full = value.length === 3 ? [...value].map((digit) => digit + digit).join("") : value;
  return `#${full}`;
}

/**
 * The theme ink: the two `--accent` values in `src/styles/globals.css`, spelled
 * out because a line drawn inside a book's own iframe cannot read a custom
 * property that lives out here.
 */
const THEME_INK = { dark: "#e9a13b", light: "#96591a" } as const;

/**
 * The theme wash inside a book's iframe, pre-divided by foliate's
 * `--overlayer-highlight-opacity` (0.3, a variable this app never sets) so the
 * painted alpha lands on the app's own `--accent-soft`.
 */
const TTS_WASH_BOOK = {
  dark: "rgba(233, 161, 59, 0.533)",
  light: "rgba(150, 89, 26, 0.4)",
} as const;

/** foliate's `Overlayer.highlight` bakes this into its group. */
const OVERLAYER_OPACITY = 0.3;

/**
 * Markers are laid on at the strength the annotation highlights use. The theme
 * tint is not, and never has been: it sits under a voice that never stops
 * moving, so it stays the faint one — `--accent-soft`'s own 0.16 / 0.12 on the
 * page, and their pre-divided twins inside a book. Two regimes, each with a
 * reason.
 */
const MARKER_ALPHA = { dark: 0.26, light: 0.36 } as const;

/** The ink a line is drawn in. Lines are drawn at full strength, the way an
 *  annotation's underline is: a half-transparent rule reads as a defect. */
export function washInk(color: TtsWashColor, dark: boolean): string {
  return color ?? (dark ? THEME_INK.dark : THEME_INK.light);
}

/** The band's fill. The theme case stays the token itself rather than a copy of
 *  its two values, so the wash and `--accent-soft` cannot drift apart. */
function washBand(color: TtsWashColor, dark: boolean): string {
  if (color === null) return "var(--accent-soft)";
  const alpha = dark ? MARKER_ALPHA.dark : MARKER_ALPHA.light;
  return inkWash(color, alpha);
}

/**
 * One wash as inline style. Used by the prose path directly and, serialised by
 * `washRule`, by the PDF path — one source, so the two cannot drift.
 *
 * 轮廓 is drawn as a four-way `text-shadow` rather than CSS `outline`: an
 * outline is never broken across lines, so a run that wraps would get one box
 * spanning several lines, while a shadow follows the glyphs and takes no part
 * in layout — which also keeps a wash from reflowing the column it is drawn on.
 */
export function washCss(style: TtsWashStyle, color: TtsWashColor, dark: boolean): CSSProperties {
  const ink = washInk(color, dark);
  switch (style) {
    case "underline":
      return {
        textDecoration: "underline",
        textDecorationColor: ink,
        // Lengths are written with their unit: `washRule` serialises these into
        // a rule, where a bare number is not a length and gets dropped.
        textDecorationThickness: "2px",
        textUnderlineOffset: "3px",
      };
    case "strikethrough":
      return {
        textDecoration: "line-through",
        textDecorationColor: ink,
        textDecorationThickness: "2px",
      };
    case "squiggly":
      return {
        textDecoration: "underline wavy",
        textDecorationColor: ink,
        textDecorationThickness: "1.5px",
        textUnderlineOffset: "3px",
      };
    case "outline":
      return {
        textShadow: `1px 0 0 ${ink}, -1px 0 0 ${ink}, 0 1px 0 ${ink}, 0 -1px 0 ${ink}`,
      };
    default:
      return { backgroundColor: washBand(color, dark), borderRadius: "2px" };
  }
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** `washCss` as the body of a `::highlight` rule. */
export function washRule(style: TtsWashStyle, color: TtsWashColor, dark: boolean): string {
  return Object.entries(washCss(style, color, dark))
    .map(([key, value]) => `${kebab(key)}: ${String(value)};`)
    .join(" ");
}

/**
 * What foliate's overlayer needs: which painter, and the colour to hand it.
 *
 * `Overlayer.highlight` paints its group at `--overlayer-highlight-opacity`, so
 * the colour is divided back up to land where the prose path lands. The four
 * line painters take a colour as-is, which is what the annotation highlights
 * pass them too. On white paper the divided marker alpha tops out at 1 — one
 * notch lighter than the prose path's band, and the only place the two paths
 * disagree.
 */
export function foliateWash(
  style: TtsWashStyle,
  color: TtsWashColor,
  dark: boolean,
): { draw: TtsWashStyle; color: string } {
  if (style !== "highlight") return { draw: style, color: washInk(color, dark) };
  if (color === null)
    return { draw: "highlight", color: dark ? TTS_WASH_BOOK.dark : TTS_WASH_BOOK.light };
  const alpha = dark ? MARKER_ALPHA.dark : MARKER_ALPHA.light;
  return { draw: "highlight", color: inkWash(color, Math.min(1, alpha / OVERLAYER_OPACITY)) };
}
