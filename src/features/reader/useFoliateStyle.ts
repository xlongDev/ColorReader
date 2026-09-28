import { useMemo } from "react";

import type { FoliateStyle } from "@/features/reader/foliateStyle";
import {
  bundledFacesFor,
  fontFaceCss,
  resolveFont,
  type ReadingSurface,
} from "@/features/reader/theme";
import { LINE_HEIGHTS, PARA_GAPS } from "@/stores/reader";
import type { LocalFont } from "@/types/ipc";

/**
 * The reading settings as the foliate renderer wants them.
 *
 * This is the other half of `foliateStyle.css`: that module turns a
 * `FoliateStyle` into the sheet injected into every section document, and this
 * is the one place the settings become one. It is a hook rather than inline
 * because the answer is memoised on nine inputs and any one of them moving
 * re-paginates the whole book — and because the three non-obvious rules below
 * belong next to the field they decide.
 *
 * Two of those rules are worth stating out loud:
 *
 * - The palette comes from the **reading surface, not the shell theme** — the
 *   same trigger as the PDF night path. Surfaces are absolute: a reader can sit
 *   on a night page while the app is in day mode.
 * - Inverting a book's pictures is the **reader's** call, not the surface's.
 *   Off by default: the palette already makes the page dark, and an inverted
 *   photograph reads as a defect rather than a feature.
 */

export interface FoliateStyleOptions {
  fontSize: number;
  /** The stored font key, not the resolved stack. */
  font: string;
  lineHeightIdx: number;
  paraGapIdx: number;
  indent: boolean;
  surface: ReadingSurface;
  invertImages: boolean;
  /** The fonts the reader imported. */
  fonts: LocalFont[];
  /** Vertical CJK: the paginator reads it back off the section and takes the
   *  column axis, the margins and its vertical page turn from it. */
  vertical: boolean;
}

export function useFoliateStyle({
  fontSize,
  font,
  lineHeightIdx,
  paraGapIdx,
  indent,
  surface,
  invertImages,
  fonts,
  vertical,
}: FoliateStyleOptions): FoliateStyle {
  return useMemo(
    () => ({
      fontSize,
      fontFamily: resolveFont(font),
      lineHeight: LINE_HEIGHTS[lineHeightIdx] ?? 1.7,
      paraGap: PARA_GAPS[paraGapIdx] ?? 0.9,
      indent,
      fg: surface.fg,
      bg: surface.tint,
      // Same trigger as the PDF night path: the reading surface decides, not
      // the shell theme (surfaces are absolute).
      dark: surface.mode === "dark",
      // Inverting a book's pictures is the reader's call, not the surface's.
      invertImages,
      // A section is its own document, so the faces have to travel with the
      // sheet rather than come from the app's own style — the imported ones
      // and the ones the app ships (霞鹜文楷), which is the difference between
      // the reader picking it and the reader getting the system 楷体.
      fontFaces: [fontFaceCss(fonts), bundledFacesFor(font)].filter(Boolean).join("\n"),
      vertical,
    }),
    [
      fontSize,
      lineHeightIdx,
      paraGapIdx,
      indent,
      surface.fg,
      surface.mode,
      surface.tint,
      invertImages,
      fonts,
      font,
      vertical,
    ],
  );
}
