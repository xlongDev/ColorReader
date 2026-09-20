import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { LayoutMode, PageTransition } from "@/features/reader/theme";
import type { SpeechGranularity } from "@/features/reader/speech";
import type { AnnotationStyle } from "@/types/ipc";

/** Reading typography and viewing preferences, persisted across sessions. */
interface ReaderState {
  /** Body font size in px. */
  fontSize: number;
  setFontSize: (size: number) => void;
  /** Speech rate for read-aloud, a Web Speech `utterance.rate` value. Set from
   *  the player's speed view through `update`. */
  speechRate: number;
  /** Chosen read-aloud voice, a `SpeechSynthesisVoice.voiceURI`; `null` keeps
   *  the default pick (Yunjian), resolved at speak time. */
  speechVoiceURI: string | null;
  /** How much of the page the voice washes: sentence, word or paragraph. */
  speechGranularity: SpeechGranularity;
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
  /** How much of the "N / M 页" page indicator to show in paged layouts. */
  pageNumbers: PageNumberScope;
  /**
   * Where the page's palette comes from — the app theme, or a fixed choice.
   * `null` means the reader has never decided, which is the state a fresh
   * install (and an upgraded one) starts in; `snapPageTheme` resolves it once
   * against the app theme of the day, and from then on it is a real choice the
   * UI shows and can set back to `follow`.
   *
   * The page used to follow the app theme unconditionally. On a foliate book
   * that is not free: foliate's `setStyles` re-injects the stylesheet into
   * every loaded section and `expand()`s each one, so a theme switch
   * re-paginates the whole book. Pinning it here leaves the app theme
   * affecting only the chrome — and since the snapshot happens on first run,
   * the cheap path is the one everybody gets without opting in.
   */
  pageTheme: PageTheme | null;
  /**
   * Resolve an undecided `pageTheme` against the app theme, once. Idempotent:
   * a page theme that is already a choice — including one the reader made back
   * into `follow` — is left alone, so this never overrides a decision.
   */
  snapPageTheme: (appIsDark: boolean) => void;
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
  /** Books (EPUB / Kindle / comics) on a night page: invert their pictures
   *  too. Off by default — the injected palette already darkens the paper,
   *  and an inverted photograph is a defect rather than a feature. On is for
   *  readers who want the whole page dim, e.g. a comic whose pages are one
   *  bright bitmap each. */
  invertBookImages: boolean;
  /** Last ink colour the reader picked in the selection toolbar (hex). */
  highlightColor: string;
  /** Last paint style the reader picked in the selection toolbar. */
  highlightStyle: AnnotationStyle;
  /** Applies a partial settings patch in one call. */
  update: (
    patch: Partial<
      Omit<ReaderState, "update" | "setFontSize" | "setReadingSpeed" | "setOriginalLayout">
    >,
  ) => void;
  setReadingSpeed: (charsPerMinute: number) => void;
}

/** Inclusive bounds for the font size stepper. */
export const MIN_FONT_SIZE = 15;
export const MAX_FONT_SIZE = 26;

/**
 * What the page indicator counts.
 *
 * `chapter` is the unit the layout actually measured — a chapter on the prose
 * pager, a foliate section in a Kindle book. `book` is the whole book: for a
 * foliate book, the counter foliate itself numbers reading positions with (a
 * property of the book's bytes, so it never moves); for the prose pager, what
 * the layout has measured plus the rest of the book weighed at that density
 * (`bookPagesOf`) — an estimate, and the only one that says 约 in front of it.
 */
export type PageNumberScope = "off" | "chapter" | "book";

/** Chip labels for the 页码 row, in display order. */
export const PAGE_NUMBER_SCOPES: { key: PageNumberScope; label: string }[] = [
  { key: "off", label: "隐藏" },
  { key: "chapter", label: "当前章" },
  // The label does not say 约; the indicator itself does, every time, which is
  // where a reader who forgot what they picked will see it.
  { key: "book", label: "全书" },
];

/**
 * Where the page's own palette comes from.
 *
 * `follow` ties the page to the app theme, which is how it used to work
 * always — and on a foliate book it is also the expensive choice: foliate's
 * `setStyles` re-injects the whole stylesheet into every loaded section and
 * then calls `expand()` on each one, so switching the app theme re-paginates
 * the book. Pinning the page to `day` or `night` means an app-theme switch
 * touches only the chrome, and the book never re-paginates.
 */
export type PageTheme = "follow" | "day" | "night";

/** Chip labels for the 书页配色 row, in display order. */
export const PAGE_THEMES: { key: PageTheme; label: string }[] = [
  { key: "follow", label: "跟随主题" },
  { key: "day", label: "日间" },
  { key: "night", label: "夜间" },
];

/**
 * Whether the page wears its night palette, given the app theme and the
 * reader's own choice.
 *
 * `follow` is the only branch that reads the app theme, so it is the only one
 * that can change under a foliate book when the reader switches the app theme.
 * An undecided `null` reads as `follow`, which is what it was before the
 * snapshot lands — the snapshot therefore never changes the palette it
 * resolves to, only what happens on the *next* theme switch.
 */
export function pageIsNight(pageTheme: PageTheme | null, appIsDark: boolean): boolean {
  return pageTheme === "night" || (pageTheme !== "day" && appIsDark);
}

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

/**
 * Auto-scroll speed bounds in px per second, and the initial speed.
 *
 * The scale was halved: at 300 CPM a reader covers roughly 40 px of a normal
 * page per second, so the old 适中 (80) was already twice reading pace and
 * 极快 (320) was a firehose. The presets below are the new scale; a stored
 * speed from before is halved by the migration rather than left behind.
 */
export const MIN_AUTO_SCROLL_SPEED = 20;
export const MAX_AUTO_SCROLL_SPEED = 240;
export const DEFAULT_AUTO_SCROLL_SPEED = 40;

/** Ink palette of the selection toolbar, in display order. The first entry is
 *  the legacy marker yellow, so old highlights and new ones read alike. */
export const HIGHLIGHT_COLORS = [
  { hex: "#ffd12e", label: "黄色" },
  { hex: "#f76f6f", label: "红色" },
  { hex: "#7cd92c", label: "绿色" },
  { hex: "#56aee2", label: "蓝色" },
  { hex: "#b08fe8", label: "紫色" },
] as const;

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

/**
 * Every reading preference at its shipping value.
 *
 * Split out from the store body so that "restore everything" is one write
 * rather than a second list of defaults that can drift from the first — see
 * `resetAllSettings`. The actions are deliberately not in here: a reset
 * replaces what the reader chose, not what the store can do.
 */
export const DEFAULT_READER_SETTINGS = {
  fontSize: 18,
  speechRate: 1,
  speechVoiceURI: null,
  speechGranularity: "sentence",
  fontFamily: "system",
  lineHeightIdx: 1,
  paraGapIdx: 1,
  marginX: DEFAULT_MARGIN_X,
  marginY: DEFAULT_MARGIN_Y,
  indent: false,
  surface: "standard",
  nightSurface: "night",
  customSurface: null,
  pageTransition: "pan",
  layoutMode: "scroll",
  autoScrollSpeed: DEFAULT_AUTO_SCROLL_SPEED,
  readingSpeed: DEFAULT_READING_SPEED,
  pageNumbers: "off",
  pageTheme: null,
  pdfFill: true,
  pdfNight: true,
  pdfGap: 0,
  pdfInvertImages: false,
  invertBookImages: false,
  highlightColor: HIGHLIGHT_COLORS[0]!.hex,
  highlightStyle: "highlight",
} satisfies Partial<ReaderState>;

export const useReaderSettings = create<ReaderState>()(
  persist(
    (set) => ({
      ...DEFAULT_READER_SETTINGS,
      setFontSize: (size) =>
        set({ fontSize: Math.min(Math.max(size, MIN_FONT_SIZE), MAX_FONT_SIZE) }),
      snapPageTheme: (appIsDark) =>
        set((state) =>
          state.pageTheme === null ? { pageTheme: appIsDark ? "night" : "day" } : {},
        ),
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
      // Bump only when a stored value changes meaning; a newly added key needs
      // no bump — the default merge layers the persisted state over the
      // initial one.
      version: 9,
      // v1 stored the auto-scroll speed as an index into [40, 80, 160, 320];
      // v2 stored the margin as an index into [16, 32, 48, 64]. Margins are
      // continuous px now and the scale was rebased (old 特宽 = new 标准).
      // v4: `pan` was briefly removed then restored; coerce any orphaned
      //   stored `pan` → `slide` (both resolve to the same native pan path).
      // v5: the single `peel` was split into two corner-grab variants;
      //   coerce stored `peel` → `peel-br` (the bottom-right grab).
      // v6: the left-right slide and both corner peels were dropped from the
      //   picker — the reader kept none / pan / fade / paper. Every one of
      //   those values falls back to `pan`, which is the same native pan path
      //   `slide` used, so a stored preference degrades to what it looked
      //   like rather than to nothing. v4's `pan → slide` coercion is gone
      //   with it: `pan` is a real option again.
      // v7: the page indicator's boolean became a three-way scope (off /
      //   current chapter / whole book). A stored `true` becomes "chapter" —
      //   the display it already had — and anything unrecognised becomes
      //   "off" rather than leaving the row with no chip selected.
      // v8: the page palette is snapshotted from the app theme on first run
      //   now, so "never chose" and "chose follow" have to be told apart. A
      //   stored `follow` is the old default and means the former — drop it to
      //   `null` so the snapshot happens on this launch. A stored `day` or
      //   `night` is a real choice and stays: pinning a page for someone who
      //   pinned it themselves is not a migration, it is a regression.
      // v9: auto-scroll speeds were halved (see `MAX_AUTO_SCROLL_SPEED`). A
      //   stored px/s is halved with them, so a reader who chose 适中 keeps
      //   the speed they chose — only the number behind it changes.
      migrate: (persisted) => {
        const state = persisted as Partial<ReaderState> & {
          autoScrollIdx?: number;
          marginIdx?: number;
          showPageNumbers?: boolean;
        };
        const next = { ...state } as ReaderState;
        if (typeof next.autoScrollSpeed !== "number") {
          // v1's index into the *old* scale; the halving below finishes it.
          next.autoScrollSpeed = [40, 80, 160, 320][state.autoScrollIdx ?? 1] ?? 80;
        }
        next.autoScrollSpeed = Math.min(
          Math.max(Math.round(next.autoScrollSpeed / 2), MIN_AUTO_SCROLL_SPEED),
          MAX_AUTO_SCROLL_SPEED,
        );
        if (typeof next.marginX !== "number") {
          next.marginX = MARGIN_X_PRESETS[state.marginIdx ?? 1] ?? DEFAULT_MARGIN_X;
          next.marginY = DEFAULT_MARGIN_Y;
        }
        const scope = next.pageNumbers as string | undefined;
        if (scope !== "off" && scope !== "chapter" && scope !== "book") {
          next.pageNumbers = state.showPageNumbers === true ? "chapter" : "off";
        }
        const stored = next.pageTransition as string;
        if (
          stored === "slide" ||
          stored === "peel" ||
          stored === "peel-br" ||
          stored === "peel-tr"
        ) {
          next.pageTransition = "pan";
        }
        if (next.pageTheme !== "day" && next.pageTheme !== "night") {
          next.pageTheme = null;
        }
        return next;
      },
    },
  ),
);
