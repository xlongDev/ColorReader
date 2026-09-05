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
  /** Index into `PAGE_MARGINS`. */
  marginIdx: number;
  /** Two-em text-indent at the start of every paragraph. */
  indent: boolean;
  /** Reading surface, a key into `READING_SURFACES` or `"custom"`. */
  surface: string;
  /** Custom background image as a data URL, shown under a day scrim. */
  customSurface: string | null;
  /** Chapter switch animation, a key into `PAGE_TRANSITIONS`. */
  pageTransition: PageTransition;
  /** Vertical scroll, single page or two-page spread. */
  layoutMode: LayoutMode;
  /** Index into `AUTO_SCROLL_SPEEDS`. */
  autoScrollIdx: number;
  /** Sustained reading speed in chars per minute, measured while scrolling. */
  readingSpeed: number;
  /** Shows the "N / M 页" page indicator in paged layouts. */
  showPageNumbers: boolean;
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

/** Horizontal page margin presets in px. */
export const PAGE_MARGINS = [16, 32, 48, 64] as const;

/** Auto-scroll speeds in px per second. */
export const AUTO_SCROLL_SPEEDS = [40, 80, 160, 320] as const;

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

/** Next auto-scroll speed in the cycle; unknown values fall back to index 0. */
export function nextAutoScrollSpeed(index: number): number {
  return (index + 1) % AUTO_SCROLL_SPEEDS.length;
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
      marginIdx: 1,
      indent: false,
      surface: "standard",
      customSurface: null,
      pageTransition: "slide",
      layoutMode: "scroll",
      autoScrollIdx: 1,
      readingSpeed: DEFAULT_READING_SPEED,
      showPageNumbers: false,
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
      version: 1,
    },
  ),
);
