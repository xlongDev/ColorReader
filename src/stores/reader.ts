import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { LayoutMode, PageTransition } from "@/features/reader/theme";

/** Reading typography and viewing preferences, persisted across sessions. */
interface ReaderState {
  /** Body font size in px. */
  fontSize: number;
  setFontSize: (size: number) => void;
  /** Speech rate for read-aloud, a Web Speech `utterance.rate` value. */
  speechRate: number;
  setSpeechRate: (rate: number) => void;
  /** Body typeface, a key into `FONT_STACKS`. */
  fontFamily: string;
  /** Index into `LINE_HEIGHTS`. */
  lineHeightIdx: number;
  /** Index into `PARA_GAPS`. */
  paraGapIdx: number;
  /** Side page margin in px, shared by paged gutters and scroll padding. */
  marginX: number;
  /** Top/bottom page margin in px. */
  marginY: number;
  /** Two-em text-indent at the start of every paragraph. */
  indent: boolean;
  /** Reading surface for the light appearance, a `READING_SURFACES` key or `"custom"`. */
  surface: string;
  /** Reading surface for the dark appearance, same key space. */
  nightSurface: string;
  /** Custom background image as a data URL, shown under a day scrim. */
  customSurface: string | null;
  /** Chapter switch animation, a key into `PAGE_TRANSITIONS`. */
  pageTransition: PageTransition;
  /** Vertical scroll, single page or two-page spread. */
  layoutMode: LayoutMode;
  /** Auto-scroll speed in px per second. */
  autoScrollSpeed: number;
  /** Sustained reading speed in chars per minute, measured while scrolling. */
  readingSpeed: number;
  /** Shows the "N / M 页" page indicator in paged layouts. */
  showPageNumbers: boolean;
  /** PDF only: pages fill the window edge to edge, ignoring the prose margins. */
  pdfFill: boolean;
  /** PDF only: render text and vectors on the night palette, independent of
   *  the paper surface — a light theme can ask for a dark PDF and vice versa.
   *  Colours come from the `nightSurface` setting. */
  pdfNight: boolean;
  /** PDF only: gutter between the two pages of a spread, in px (0 = seamless). */
  pdfGap: number;
  /** PDF only: invert images along with the text. Off keeps photographs in
   *  their real colours; on rescues scanned books, whose pages are one bright
   *  bitmap each and would otherwise glare on a dark surface. */
  pdfInvertImages: boolean;
  /** Applies a partial settings patch in one call. */
  update: (
    patch: Partial<
      Omit<ReaderState, "update" | "setFontSize" | "setSpeechRate" | "setReadingSpeed">
    >,
  ) => void;
  setReadingSpeed: (charsPerMinute: number) => void;
}

/** Inclusive bounds for the font size stepper. */
export const MIN_FONT_SIZE = 15;
export const MAX_FONT_SIZE = 26;

/** Rates the read-aloud button cycles through, in order. */
export const SPEECH_RATES = [1, 1.25, 1.5, 2, 0.75] as const;

/** Line height presets, index-selectable in reading settings. */
export const LINE_HEIGHTS = [1.6, 1.8, 2.0, 2.2] as const;

/** Paragraph gap presets in em. */
export const PARA_GAPS = [0.6, 0.9, 1.2, 1.6] as const;

/** Horizontal page margin presets in px; the slider fine-tunes around them.
 * 标准 (96) is the old 特宽 look, promoted per the wider-page-margins brief. */
export const MARGIN_X_PRESETS = [64, 96, 128, 160] as const;

/** Bounds for the continuous side/top/bottom margin sliders, and defaults. */
export const MIN_MARGIN_X = 32;
export const MAX_MARGIN_X = 192;
export const MIN_MARGIN_Y = 24;
export const MAX_MARGIN_Y = 160;
export const DEFAULT_MARGIN_X = 96;
export const DEFAULT_MARGIN_Y = 64;

/** Auto-scroll speed bounds in px per second, and the initial speed. */
export const MIN_AUTO_SCROLL_SPEED = 20;
export const MAX_AUTO_SCROLL_SPEED = 480;
export const DEFAULT_AUTO_SCROLL_SPEED = 80;

/**
 * Folds one animation frame of auto-scroll into a whole-pixel delta plus the
 * fractional remainder carried to the next frame. Browsers snap scroll offsets
 * to device pixels, so adding a sub-pixel step each frame (a slow speed on a
 * 120 Hz display moves ~0.3 px per frame) rounds back to zero and the page
 * never moves; accumulating the fraction across frames keeps every speed moving.
 */
export function foldScrollDelta(
  speedPxPerSec: number,
  dt: number,
  carry: number,
): { delta: number; carry: number } {
  const total = carry + speedPxPerSec * dt;
  const delta = Math.trunc(total);
  return { delta, carry: total - delta };
}

/** Bounds for the measured reading speed, keeping the estimate sane. */
const MIN_READING_SPEED = 80;
const MAX_READING_SPEED = 1500;
/** Initial chars-per-minute assumption before enough reading is measured. */
const DEFAULT_READING_SPEED = 300;

/** Next rate in the cycle; `rate` falls back to index 0 when not listed. */
export function nextSpeechRate(rate: number): number {
  const index = SPEECH_RATES.indexOf(rate as (typeof SPEECH_RATES)[number]);
  return SPEECH_RATES[(index + 1) % SPEECH_RATES.length] ?? 1;
}

/**
 * Folds one scrolling session into the sustained speed estimate: an EWMA over
 * chars-per-minute samples, with implausible sessions (too short, too long, no
 * progress) ignored. Returns the previous estimate untouched when discarded.
 */
export function updateReadingSpeed(prev: number, chars: number, elapsedMs: number): number {
  const seconds = elapsedMs / 1000;
  if (chars <= 0 || seconds < 5 || seconds > 1800) return prev;
  const sample = (chars / seconds) * 60;
  const clamped = Math.min(Math.max(sample, MIN_READING_SPEED), MAX_READING_SPEED);
  return Math.round(prev * 0.7 + clamped * 0.3);
}

export const useReaderSettings = create<ReaderState>()(
  persist(
    (set) => ({
      fontSize: 18,
      setFontSize: (size) =>
        set({ fontSize: Math.min(Math.max(size, MIN_FONT_SIZE), MAX_FONT_SIZE) }),
      speechRate: 1,
      setSpeechRate: (rate) => set({ speechRate: nextSpeechRate(rate) }),
      fontFamily: "system",
      lineHeightIdx: 1,
      paraGapIdx: 1,
      marginX: DEFAULT_MARGIN_X,
      marginY: DEFAULT_MARGIN_Y,
      indent: false,
      surface: "standard",
      nightSurface: "night",
      customSurface: null,
      pageTransition: "slide",
      layoutMode: "scroll",
      autoScrollSpeed: DEFAULT_AUTO_SCROLL_SPEED,
      readingSpeed: DEFAULT_READING_SPEED,
      showPageNumbers: false,
      pdfFill: true,
      pdfNight: true,
      pdfGap: 0,
      pdfInvertImages: false,
      update: (patch) => set(patch),
      setReadingSpeed: (charsPerMinute) =>
        set({
          readingSpeed: Math.min(
            Math.max(Math.round(charsPerMinute), MIN_READING_SPEED),
            MAX_READING_SPEED,
          ),
        }),
    }),
    {
      name: "colorreader.reader",
      version: 3,
      // v1 stored the auto-scroll speed as an index into [40, 80, 160, 320];
      // v2 stored the margin as an index into [16, 32, 48, 64]. Margins are
      // continuous px now and the scale was rebased (old 特宽 = new 标准).
      migrate: (persisted) => {
        const state = persisted as Partial<ReaderState> & {
          autoScrollIdx?: number;
          marginIdx?: number;
        };
        const next = { ...state } as ReaderState;
        if (typeof next.autoScrollSpeed !== "number") {
          next.autoScrollSpeed = [40, 80, 160, 320][state.autoScrollIdx ?? 1] ?? 80;
        }
        if (typeof next.marginX !== "number") {
          next.marginX = MARGIN_X_PRESETS[state.marginIdx ?? 1] ?? DEFAULT_MARGIN_X;
          next.marginY = DEFAULT_MARGIN_Y;
        }
        return next;
      },
    },
  ),
);
