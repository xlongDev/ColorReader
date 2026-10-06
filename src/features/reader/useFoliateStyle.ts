import { useMemo } from "react";

import type { FoliateStyle } from "@/features/reader/foliateStyle";
import {
  bundledFacesFor,
  fontFaceCss,
  resolveFont,
  type ReadingSurface,
  type WritingMode,
} from "@/features/reader/theme";
import { LINE_HEIGHTS, PARA_GAPS } from "@/stores/reader";
import type { LocalFont } from "@/types/ipc";

/**
 * The reading settings as the foliate renderer wants them.
 *
 * This is the other half of `foliateStyle.css`: that module turns a
 * `FoliateStyle` into the sheet injected into every section document, and this
 * is the one place the settings become one. It is a hook rather than inline
 * because the answer is memoised on ten inputs and any one of them moving
 * re-paginates the whole book — and because the non-obvious rules below
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
 * - 原书字体 (`font === "book"`) resolves to `null`, and the sheet then
 *   injects no `font-family` at all: the book's own faces win. The prose and
 *   PDF paths keep resolving the key to the system stack — they have no book
 *   faces to keep.
 */

export interface FoliateStyleOptions {
  fontSize: number;
  /** The stored font key, not the resolved stack. */
  font: string;
  lineHeightIdx: number;
  paraGapIdx: number;
  indent: boolean;
  /** 使用书籍排版: the book's own paragraph styles stand over the reader's. */
  bookTypography: boolean;
  surface: ReadingSurface;
  invertImages: boolean;
  /** The fonts the reader imported. */
  fonts: LocalFont[];
  /** The writing direction the reader asks for; `auto` injects nothing. */
  writingMode: WritingMode;
  /** 替换引号: western quotes become vertical corner brackets at section load. */
  quoteReplace: boolean;
}

export function useFoliateStyle({
  fontSize,
  font,
  lineHeightIdx,
  paraGapIdx,
  indent,
  bookTypography,
  surface,
  invertImages,
  fonts,
  writingMode,
  quoteReplace,
}: FoliateStyleOptions): FoliateStyle {
  return useMemo(
    () => ({
      fontSize,
      fontFamily: font === "book" ? null : resolveFont(font),
      lineHeight: LINE_HEIGHTS[lineHeightIdx] ?? 1.7,
      paraGap: PARA_GAPS[paraGapIdx] ?? 0.9,
      indent,
      bookTypography,
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
      writingMode,
      quoteReplace,
    }),
    [
      fontSize,
      lineHeightIdx,
      paraGapIdx,
      indent,
      bookTypography,
      surface.fg,
      surface.mode,
      surface.tint,
      invertImages,
      fonts,
      font,
      writingMode,
      quoteReplace,
    ],
  );
}
