import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  FoliateHandle,
  FoliateLocation,
  FoliateSelection,
  FoliateTocEntry,
} from "./FoliateBookView";
import {
  ArrowsOut,
  ArrowsIn,
  ArrowClockwise,
  DownloadSimple,
  ArrowLeft,
  ArrowDown,
  BookOpen,
  CaretLeft,
  CaretRight,
  Faders,
  Graph,
  HighlighterCircle,
  BookmarkSimple,
  ListBullets,
  MagnifyingGlass,
  Minus,
  Pause,
  Plus,
  SpeakerHigh,
  Trash,
  X,
} from "@phosphor-icons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton, GlassIconButton } from "@/components/glass/button";
import { GraphPanel } from "@/features/graph/GraphPanel";
import {
  globalProgress,
  locateChapter,
  remainingChars,
  estimateLabel,
  totalChars,
} from "@/features/reader/progress";
import { SettingsPanel } from "@/features/reader/SettingsPanel";
import { TocPanel } from "@/features/reader/TocPanel";
import {
  highlightSegments,
  joinedText,
  paragraphAt,
  paragraphStart,
  resolveSelection,
  type TextRange,
} from "@/features/reader/selection";
import { useSpeechVoices, useTts } from "@/features/reader/tts";
import { TtsPlayer, type SleepChoice, type SleepTimer } from "@/features/reader/TtsPlayer";
import { defaultVoice, engineOf } from "@/features/reader/voice";
import {
  cursorAt,
  speechUnits,
  washSpan,
  type SpeechSource,
  type SpeechUnit,
} from "@/features/reader/speech";
import { FoliateSearchPanel } from "./FoliateSearchPanel";
import {
  resolveFont,
  resolveSurface,
  readerGlassVars,
  type LayoutMode,
  type PageTransition,
} from "@/features/reader/theme";
import { SearchPanel } from "@/features/search/SearchPanel";
import { useAnnotations, useCreateAnnotation, useDeleteAnnotation } from "@/hooks/useAnnotations";
import { useBookmarks, useCreateBookmark, useDeleteBookmark } from "@/hooks/useBookmarks";
import { useAiChat } from "@/hooks/useAi";
import { useResolvedTheme } from "@/hooks/useTheme";
import { useIndexBook, useRagStatus } from "@/hooks/useRag";
import {
  useBook,
  useBookImages,
  useChapter,
  usePdfOutline,
  useReaderToc,
  useSetProgress,
} from "@/hooks/useReader";
import {
  LINE_HEIGHTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  PARA_GAPS,
  foldScrollDelta,
  updateReadingSpeed,
  useReaderSettings,
} from "@/stores/reader";
import { useChrome } from "@/stores/chrome";
import { useSettings } from "@/stores/settings";
import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import type {
  Annotation,
  BookFormat,
  BookImage,
  Bookmark,
  ChapterMeta,
  RagHit,
  SearchHit,
} from "@/types/ipc";

/** pdf.js is ~1 MB; it only ever ships inside its own lazy chunk, loaded the
    first time a PDF book is opened. */
const PdfPageView = lazy(() =>
  import("@/features/reader/PdfPageView").then((module) => ({ default: module.PdfPageView })),
);
const PdfScrollView = lazy(() =>
  import("@/features/reader/PdfScrollView").then((module) => ({ default: module.PdfScrollView })),
);
/** foliate-js (MOBI/AZW3 rendering engine) is only fetched for Kindle books. */
const FoliateBookView = lazy(() => import("@/features/reader/FoliateBookView"));

/** How long to wait after scrolling stops before persisting the position. */
const SAVE_DELAY_MS = 600;

/** Gutter between the two columns of a spread: the page margin itself, so the
 * centre gap matches the outer margins and both paged modes share one rhythm. */

/** Wheel silence (ms) that ends one trackpad gesture and re-arms paging. */
const GESTURE_GAP = 200;

/** A paragraph starting with this marker renders as an in-book image. */
const IMAGE_PARAGRAPH_PREFIX = "￼";

/** A paragraph starting with this marker is an in-book link (EPUB table of
    contents entry): `<target chapter idx>\u{1F}<text>`, resolved at import
    time by the document parser. */
const LINK_PARAGRAPH_PREFIX = "￻";
const LINK_FIELD_SEPARATOR = "\u{1F}";

/** A paragraph starting with this marker is the chapter's wallpaper (a Kindle
    CSS page background): painted behind the text, never flowed inline. */
const WALLPAPER_PARAGRAPH_PREFIX = "\u{FFFA}";

/** Lightbox zoom bounds and wheel/button step. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;

/** PDF zoom bounds and pinch/button step; 1 = fitted to the window. */
const MIN_PDF_ZOOM = 0.5;
const MAX_PDF_ZOOM = 4;
const PDF_ZOOM_STEP = 1.25;

/** Extra margin on all four sides while in fullscreen immersion. */
const FULLSCREEN_MARGIN_BONUS = 48;

/** Parses a link-marker paragraph (`<marker><idx><sep><text>`) into its
    target chapter and visible text; `null` when malformed. */
function parseLinkParagraph(paragraph: string): { idx: number; text: string } | null {
  const payload = paragraph.slice(LINK_PARAGRAPH_PREFIX.length);
  const separator = payload.indexOf(LINK_FIELD_SEPARATOR);
  if (separator < 0) return null;
  const idx = Number.parseInt(payload.slice(0, separator), 10);
  const text = payload.slice(separator + LINK_FIELD_SEPARATOR.length);
  return Number.isFinite(idx) && text ? { idx, text } : null;
}

/** Read-aloud sources for a chapter: image placeholders say nothing at all,
    link entries speak their visible text. */
function speechSources(paragraphs: string[]): SpeechSource[] {
  const out: SpeechSource[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX)) return;
    if (paragraph.startsWith(LINK_PARAGRAPH_PREFIX)) {
      const text = paragraph.split(LINK_FIELD_SEPARATOR)[1] ?? "";
      if (text.trim() !== "") out.push({ index, text });
      return;
    }
    if (paragraph.trim() !== "") out.push({ index, text: paragraph });
  });
  return out;
}

/** True for a paragraph that renders as running text — the only kind the
    read-aloud wash can be drawn on. */
function isProseParagraph(paragraph: string | undefined): paragraph is string {
  return (
    paragraph !== undefined &&
    paragraph.trim() !== "" &&
    !paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX) &&
    !paragraph.startsWith(LINK_PARAGRAPH_PREFIX)
  );
}

/**
 * Index of the first utterance at or after `offset` in the chapter's joined
 * text — the sentence "read from here" lands on. Falls back to the top when
 * the offset is past the last unit, so the voice always starts somewhere.
 */
function unitAtOffset(queue: readonly SpeechUnit[], paragraphs: string[], offset: number): number {
  const paragraph = paragraphAt(paragraphs, offset);
  const local = offset - paragraphStart(paragraphs, paragraph);
  const at = queue.findIndex(
    (unit) => unit.source > paragraph || (unit.source === paragraph && unit.end > local),
  );
  return at < 0 ? 0 : at;
}

/** Which side panel is open. Only one at a time, so they never stack. */
type Panel = "none" | "annotations" | "search" | "ai" | "graph" | "toc" | "settings";

/** Distance between neighbouring column boundaries in a paged layout (px).
 * `margin` is the final applied side margin. */
function columnPitch(el: HTMLDivElement, mode: LayoutMode, margin: number): number {
  const content = el.clientWidth - margin * 2;
  const colWidth = mode === "double" ? (content - margin) / 2 : content;
  return colWidth + margin;
}

/** Applies a saved fraction along the active axis of the reading viewport. */
function applyPosition(
  el: HTMLDivElement,
  fraction: number,
  mode: LayoutMode,
  margin: number,
): void {
  if (mode === "scroll") {
    el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
    return;
  }
  const max = el.scrollWidth - el.clientWidth;
  // Paged modes always land on a column boundary: a proportional offset would
  // leave a column sliced in half after a reflow or a window resize.
  const pitch = columnPitch(el, mode, margin);
  const columns = pitch > 0 ? Math.round((fraction * max) / pitch) : 0;
  el.scrollLeft = Math.min(columns * pitch, Math.max(max, 0));
}

/** A transparent strip that pads the scroll range so the chapter's last page
 * also starts exactly on a column boundary. */
interface TailPad {
  left: number;
  width: number;
}

/**
 * Chapter content rarely spans an exact multiple of the column pitch, so the
 * maximum scroll offset lands mid-column and the last page shows slivers of
 * its neighbours. Extends the scroll range with an absolutely-positioned
 * spacer until the end aligns with the grid.
 */
function alignTail(
  el: HTMLDivElement,
  mode: LayoutMode,
  margin: number,
  ref: React.RefObject<TailPad | null>,
  set: (pad: TailPad | null) => void,
): void {
  if (mode === "scroll") {
    if (ref.current !== null) {
      ref.current = null;
      set(null);
    }
    return;
  }
  const pitch = columnPitch(el, mode, margin);
  // Exclude the currently rendered spacer so the measurement is idempotent.
  const contentEnd = el.scrollWidth - (ref.current?.width ?? 0);
  const max = contentEnd - el.clientWidth;
  const width = pitch > 0 && max > 0 ? (pitch - (max % pitch)) % pitch : 0;
  const next = width > 0 ? { left: contentEnd, width } : null;
  const prev = ref.current;
  if (next?.width !== prev?.width || next?.left !== prev?.left) {
    ref.current = next;
    set(next);
  }
}

/**
 * Performs one in-chapter page flip, honouring the page-transition setting:
 * "slide" and "pan" keep the native smooth scroll (the same clipped horizontal
 * slide the MOBI path uses via foliate's native pan, and the EPUB prose path
 * via `scrollTo`); "fade", "paper" and the two peels jump to the target page
 * instantly and animate the new page in via WAAPI — imperative, so a flip never
 * re-renders or remounts the chapter — and "none" jumps with no animation.
 * Reduced motion always jumps instantly.
 */
function flipPage(
  el: HTMLElement,
  left: number,
  mode: PageTransition,
  dir: 1 | -1,
  /** `null` while motion preference is undetermined; treated as no reduction. */
  reduced: boolean | null,
) {
  if (reduced || mode === "slide" || mode === "pan") {
    el.scrollTo({ left, behavior: "smooth" });
    return;
  }
  if (mode === "none") {
    el.scrollTo({ left, behavior: "auto" });
    return;
  }
  el.scrollTo({ left, behavior: "auto" });
  // The prose path animates the incoming page, so the peel is mirrored: the
  // page settles out of the crease fold instead of folding away. `grabTop`
  // mirrors the crease axis for the top-right variant.
  const grabTop = mode === "peel-tr";
  const axis = grabTop ? "0.667" : "-0.667";
  const frames: Keyframe[] =
    mode === "fade"
      ? [{ opacity: 0 }, { opacity: 1 }]
      : mode === "peel-br" || mode === "peel-tr"
        ? [
            {
              opacity: 0,
              transform: `perspective(1400px) translate3d(6%, ${grabTop ? "-6" : "6"}%, 0) rotate3d(1, ${axis}, 0, ${grabTop ? "12" : "-12"}deg)`,
            },
            {
              opacity: 1,
              transform: `perspective(1400px) translate3d(0, 0, 0) rotate3d(1, ${axis}, 0, 0deg)`,
            },
          ]
        : [
            {
              opacity: 0,
              transform: `perspective(1200px) rotateY(${dir === 1 ? -10 : 10}deg)`,
              transformOrigin: dir === 1 ? "left center" : "right center",
            },
            { opacity: 1, transform: "perspective(1200px) rotateY(0deg)" },
          ];
  const duration = mode === "paper" ? 400 : mode === "peel-br" || mode === "peel-tr" ? 420 : 300;
  el.animate(frames, { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
}

interface ReaderViewProps {
  bookId: string;
  title: string;
  /** Cover on the `colorreader` resource protocol, for the TTS player card. */
  coverUrl: string | null;
  /** Book's own language tag, for the TTS voice picker's language lead. */
  bookLanguage: string | null;
  /** How the book is stored; PDF renders its fixed pages instead of prose. */
  format: BookFormat;
  chapters: ChapterMeta[];
  initialProgress: number;
  /** Stored reading anchor for foliate books (a CFI); `null` for the rest. */
  initialCfi: string | null;
  /** Chapter given in the URL, or `null` to resume the saved position. */
  initialChapter: number | null;
  /** Search term carried over from a result, highlighted in the chapter. */
  initialQuery: string;
  /** Character offset of a search hit, scrolled into view once rendered. */
  initialOffset: number | null;
  onBack: () => void;
}

/**
 * The reader surface. Rendered only once the book, chapter table and a saved
 * position are all known, so the resume position is captured synchronously in
 * the initial state instead of being back-filled by an effect.
 */
function ReaderView({
  bookId,
  title,
  coverUrl,
  bookLanguage,
  format,
  chapters,
  initialProgress,
  initialCfi,
  initialChapter,
  initialQuery,
  initialOffset,
  onBack,
}: ReaderViewProps) {
  // Destructure `mutate`: the mutation result object gets a new identity on
  // every render, and a per-render `setProgress` would drag `goTo` and the
  // position effect along, snapping the scroll back to the top on each frame.
  const { mutate: setProgress } = useSetProgress(bookId);
  const settings = useReaderSettings();
  const {
    fontSize,
    setFontSize,
    lineHeightIdx,
    paraGapIdx,
    marginX,
    marginY,
    indent,
    surface: surfaceKey,
    customSurface,
    pageTransition,
    layoutMode,
    autoScrollSpeed,
    readingSpeed,
    setReadingSpeed,
    showPageNumbers,
    pdfFill,
    pdfNight: pdfNightOn,
    pdfGap,
    pdfInvertImages,
  } = settings;
  const speechRate = settings.speechRate;
  const speechVoiceURI = settings.speechVoiceURI;
  const speechGranularity = settings.speechGranularity;
  const reduce = useReducedMotion();
  const annotationsQuery = useAnnotations(bookId);
  const createAnnotation = useCreateAnnotation(bookId);
  const deleteAnnotation = useDeleteAnnotation(bookId);
  const bookmarksQuery = useBookmarks(bookId);
  const createBookmark = useCreateBookmark(bookId);
  const deleteBookmark = useDeleteBookmark(bookId);
  // Destructure: each action is a stable useCallback, so effects that depend
  // on them individually never re-fire when speech state changes.
  const {
    status: speechStatus,
    unit: speechUnit,
    boundary: speechBoundary,
    error: speechError,
    play,
    stop,
    pause,
    resume,
    setRate,
    setVoice,
    boundaryAt,
  } = useTts({ trackBoundary: speechGranularity === "word" });

  // The voice actually used, resolved rather than stored: with nothing saved the
  // answer is the reader's default — Yunjian, which only the Edge service has —
  // and when that service is unreachable it degrades to a voice the platform
  // owns instead of going silent.
  const { voices: speechVoices } = useSpeechVoices();
  const effectiveVoice = useMemo(
    () => speechVoiceURI ?? defaultVoice(speechVoices, null)?.uri ?? null,
    [speechVoiceURI, speechVoices],
  );

  // Player surfaces. The sleep timer is the parent's business — it owns the
  // voice, so it is what has to stop it; the card only draws the countdown.
  const [playerOpen, setPlayerOpen] = useState(false);
  const [sleep, setSleep] = useState<SleepTimer>(null);
  // Mirrored into a ref: `onChapterEnd` is a dependency of the position effect
  // below, and a fresh identity there would re-apply the pending scroll — which
  // would yank the page back to the top of the chapter the moment a timer is
  // armed.
  const sleepRef = useRef<SleepTimer>(null);
  useEffect(() => {
    sleepRef.current = sleep;
  }, [sleep]);

  const annotations = annotationsQuery.data;
  const bookmarks = bookmarksQuery.data;
  // Saved annotations grouped by 0-based PDF page, memoised so the per-page
  // text-layer paint effects only rerun when the query data changes.
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const annotation of annotations ?? []) {
      const list = map.get(annotation.chapterIdx) ?? [];
      list.push(annotation);
      map.set(annotation.chapterIdx, list);
    }
    return map;
  }, [annotations]);
  // A PDF has no prose of its own: chapters are pages, and the fixed pages are
  // rendered by pdf.js. The extracted text still powers search, TTS and AI.
  const isPdf = format === "pdf";
  // Kindle containers render through foliate-js: for KF8 the book's own
  // XHTML + CSS is the only faithful rendering — wallpapers, part-title
  // plates and inline art survive, which a text extraction cannot do.
  const isMobi = format === "mobi";
  // A foliate position is a CFI, an opaque string our (chapter, fraction)
  // progress model cannot express. It rides in `books.location`; the
  // localStorage key it used to park in is read once as a fallback and
  // cleared the moment the database has the value.
  const mobiCfiKey = `colorreader:foliate:${bookId}`;
  const startCfi = useMemo(
    () => (isMobi ? (initialCfi ?? localStorage.getItem(mobiCfiKey)) : null),
    [initialCfi, isMobi, mobiCfiKey],
  );
  const outlineQuery = usePdfOutline(bookId, isPdf);
  const outline = outlineQuery.data ?? [];
  const [panel, setPanel] = useState<Panel>("none");
  const [search, setSearch] = useState(initialQuery);
  const [pending, setPending] = useState<{
    range: TextRange;
    x: number;
    y: number;
    annotationId?: string;
    /** The chapter (or PDF page, 0-based) the range belongs to; defaults to
     *  the chapter on screen. PDF selections set it — a two-page spread can
     *  surface a pill whose range lives on the other page. */
    chapterIdx?: number;
    /** The foliate CFI of this range. Kindle sections do not line up with
     *  our chapter indices, so a mobi highlight is anchored by this instead. */
    cfi?: string;
  } | null>(null);
  // Quoted text for the AI drawer; `null` means "use the whole chapter".
  const [aiContext, setAiContext] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [autoScrolling, setAutoScrolling] = useState(false);
  // End-of-chapter column alignment spacer; mirror kept for idempotent measures.
  const [tail, setTail] = useState<TailPad | null>(null);
  const tailRef = useRef<TailPad | null>(null);

  // A chapter named in the URL wins over the saved position: arriving from a
  // search result means "open here", not "resume".
  const start = useMemo(
    () =>
      initialChapter === null
        ? locateChapter(chapters, initialProgress)
        : { idx: Math.min(initialChapter, chapters.length - 1), fraction: 0 },
    [chapters, initialProgress, initialChapter],
  );

  const [chapterIdx, setChapterIdx] = useState(start.idx);
  const [displayProgress, setDisplayProgress] = useState(() =>
    globalProgress(chapters, start.idx, start.fraction),
  );
  /** Fraction inside the current chapter, for labels and bookmarking. */
  const [fraction, setFraction] = useState(start.fraction);
  /** Direction of the last chapter switch, drives the page transition. */
  const [nav, setNav] = useState<1 | -1>(1);
  // The book's own table of contents, handed over by foliate once the file is
  // open. Kindle sections do not line up with the chapters our importer
  // extracts, so the TOC panel switches to this list while reading a mobi.
  const [foliateToc, setFoliateToc] = useState<FoliateTocEntry[]>([]);
  const [mobiSectionLabel, setMobiSectionLabel] = useState("");
  /** Section page counter from foliate; feeds the same indicator as
   *  `pageInfo` (separate state because this one is declared earlier). */
  const [mobiPage, setMobiPage] = useState<{ page: number; pages: number } | null>(null);
  // Declared after the state it reports into (React Compiler forbids a
  // callback capturing a setter that is still initializing).
  const rememberMobiLocation = useCallback(
    (location: FoliateLocation) => {
      // foliate reports true whole-book progress; our chapter-index estimate
      // (51 chapters of uneven length) drifts badly on Kindle files.
      setDisplayProgress(location.fraction);
      setMobiSectionLabel(location.label);
      // The section page counter feeds the same "N / M 页" indicator the
      // prose pager drives; null in the scroll layout clears it.
      setMobiPage(location.page && { page: location.page.current, pages: location.page.total });
      if (location.cfi === "") return;
      const cfi = location.cfi;
      if (mobiSaveRef.current !== null) window.clearTimeout(mobiSaveRef.current);
      mobiSaveRef.current = window.setTimeout(() => {
        // The CFI goes to the database, where it survives a cache clear and
        // travels with the library row; the old parking spot is retired.
        setProgress({ progress: location.fraction, location: cfi });
        localStorage.removeItem(mobiCfiKey);
      }, SAVE_DELAY_MS);
    },
    [mobiCfiKey, setProgress],
  );

  /** Continuous scroll vs paged single/double spread. */
  const paged = layoutMode !== "scroll";
  /** Viewport width, drives the column layout of paged modes. */
  const [viewportW, setViewportW] = useState(0);
  /** Viewport height, caps images to one page box in paged modes (see
      globals.css `.paged-prose`; the measured px beats any 100vh estimate). */
  const [viewportH, setViewportH] = useState(0);
  // While the sidebar spring resizes the reading pane, the article is pinned
  // at its current px width: a per-frame multicol re-wrap of the whole
  // chapter is what makes the animation janky on this page (the library has
  // no such layout, so only the reader pays). Released after the spring
  // settles into a single reflow + re-anchor. `pinnedRef` mirrors the state
  // for the ResizeObserver / store-subscriber callbacks.
  const [pinnedW, setPinnedW] = useState<number | null>(null);
  const pinnedRef = useRef<number | null>(null);
  const pinReleaseRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The foliate view for Kindle formats, driven imperatively (see flip /
  // stepChapter): paging and sections never touch our chapter index.
  const mobiRef = useRef<FoliateHandle | null>(null);
  // Fraction to apply once the current chapter body has rendered. Starts at the
  // saved position, then is reset to the top of the chapter on navigation.
  const pendingScroll = useRef<number>(start.fraction);
  // Offset of a search hit to reveal instead of the scroll fraction.
  const pendingFocus = useRef<number | null>(initialOffset);
  const debounceRef = useRef<number | null>(null);
  // Pending debounce of the Kindle position save (a CFI, so it only ever
  // carries the latest one — a page-turn storm must not queue a write each).
  const mobiSaveRef = useRef<number | null>(null);
  // Latest position along the active axis, read outside the scroll handler.
  const fractionRef = useRef<number>(start.fraction);
  // Mirror of the layout mode so scroll-dependent callbacks never go stale;
  // kept in sync by the layout effect below.
  const layoutModeRef = useRef<LayoutMode>(layoutMode);
  // Same trick for the side margin: it sets the column pitch. Holds the final
  // applied value (setting + fullscreen bonus), synced by an effect below,
  // mirroring layoutModeRef.
  const marginRef = useRef<number>(marginX + (fullscreen ? FULLSCREEN_MARGIN_BONUS : 0));
  // Scroll-layout PDF bookkeeping: the slot height reported by PdfScrollView
  // maps pages to scroll offsets, the label follows the scrolled page, and the
  // suppress flag stops a page-jump's chapter load from re-applying position 0.
  const pdfSlotH = useRef(0);
  const suppressPdfPending = useRef(false);
  const [pdfScrollPage, setPdfScrollPage] = useState<number | null>(null);
  /** PDF page zoom, 1 = fitted; CSS-only over the rendered bitmap. */
  const [pdfZoom, setPdfZoom] = useState(1);
  /** True while a button-driven zoom should glide instead of snapping. */
  const [pdfZoomAnimated, setPdfZoomAnimated] = useState(false);
  // The scrolled-page label only means something in the scroll layout; reset
  // it when the layout flips (render-time adjust, the ImageLightbox pattern).
  const [prevPaged, setPrevPaged] = useState(paged);
  if (prevPaged !== paged) {
    setPrevPaged(paged);
    setPdfScrollPage(null);
  }
  const handlePdfLayout = useCallback((slotHeight: number) => {
    pdfSlotH.current = slotHeight;
    // The scroll view mounts lazily (Suspense), after the layout-switch
    // effect has already run on an empty scroller; once the slots have real
    // heights, re-anchor the fraction so entering scroll mode keeps the page.
    if (slotHeight > 0 && layoutModeRef.current === "scroll") {
      const el = scrollRef.current;
      if (el) applyPosition(el, fractionRef.current, "scroll", marginRef.current);
    }
  }, []);
  /** Previous progress sample for the sustained reading speed estimate. */
  const speedSampleRef = useRef<{ at: number; chars: number } | null>(null);
  /** Hover-reveal flip affordance for paged modes; hides itself after 2s idle. */
  const [flipHint, setFlipHint] = useState(false);
  /** 1-based position inside the chapter's column count, for the page indicator. */
  const [pageInfo, setPageInfo] = useState<{ page: number; pages: number } | null>(null);
  /** Book image opened in the lightbox viewer, an index into the book-wide `bookImages`. */
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const flipHintTimer = useRef<number | null>(null);
  // WebKit synthesizes mousemoves when content scrolls under a resting cursor
  // (keyboard and wheel flips), which would wake the flip chrome. Only real
  // pointer travel re-reveals it; pointer-down still always does.
  const lastPointer = useRef({ x: 0, y: 0 });
  const revealFlipHint = useCallback(() => {
    setFlipHint(true);
    if (flipHintTimer.current !== null) window.clearTimeout(flipHintTimer.current);
    flipHintTimer.current = window.setTimeout(() => setFlipHint(false), 2000);
  }, []);
  const revealFlipHintOnMove = useCallback(
    (event: React.MouseEvent) => {
      const dx = event.clientX - lastPointer.current.x;
      const dy = event.clientY - lastPointer.current.y;
      lastPointer.current = { x: event.clientX, y: event.clientY };
      if (Math.hypot(dx, dy) < 3) return;
      revealFlipHint();
    },
    [revealFlipHint],
  );
  useEffect(
    () => () => {
      if (flipHintTimer.current !== null) window.clearTimeout(flipHintTimer.current);
    },
    [],
  );

  const chapter = useChapter(bookId, chapterIdx);
  // Wallpaper markers (Kindle CSS page backgrounds) are page decoration, not
  // content: blank them once here so TTS, search, selection and highlighting
  // never see an asset path, while every paragraph index stays stable for
  // annotation anchoring. The path itself rides along for the page painter.
  const chapterData = useMemo(() => {
    const data = chapter.data;
    if (!data) return data;
    const marker = data.paragraphs.find((paragraph) =>
      paragraph.startsWith(WALLPAPER_PARAGRAPH_PREFIX),
    );
    return {
      ...data,
      wallpaper: marker ? marker.slice(WALLPAPER_PARAGRAPH_PREFIX.length) : null,
      paragraphs: data.paragraphs.map((paragraph) =>
        paragraph.startsWith(WALLPAPER_PARAGRAPH_PREFIX) ? "" : paragraph,
      ),
    };
  }, [chapter.data]);
  const wallpaperPath = chapterData?.wallpaper ?? null;
  const bookImagesQuery = useBookImages(bookId);
  const bookImages = bookImagesQuery.data ?? [];

  // Read-aloud units for the prose path: the chapter split into sentences. The
  // Kindle path builds its own from foliate's blocks, whose text lives in
  // another document. The reader's highlight level is not part of the cut (see
  // `speechUnits`), so changing it never recuts the queue under the voice.
  const speechQueue = useMemo(
    () => (isMobi ? [] : speechUnits(speechSources(chapterData?.paragraphs ?? []))),
    [isMobi, chapterData],
  );
  // 「朗读此处」 can start the voice inside a sentence: the first utterance is
  // spoken from the selected character on, so the wash has to begin where the
  // voice does instead of at the sentence's opening character.
  const [speechTrim, setSpeechTrim] = useState<{ unit: number; trim: number } | null>(null);
  // What the wash covers, in the coordinates of the paragraph it sits in: the
  // sentence or the word the voice is on, or the whole paragraph at that level
  // (see `washSpan` for why nothing is washed until the position arrives).
  const speechSpan = useMemo(() => {
    if (speechUnit === null) return null;
    const unit = speechQueue[speechUnit];
    if (!unit) return null;
    const head = speechTrim?.unit === speechUnit ? speechTrim.trim : 0;
    const span = washSpan(
      speechUnit,
      unit,
      speechBoundary,
      speechGranularity,
      head,
      chapterData?.paragraphs?.[unit.source]?.length,
    );
    return span === null ? null : { source: unit.source, start: span.start, end: span.end };
  }, [speechUnit, speechQueue, speechGranularity, speechBoundary, speechTrim, chapterData]);
  // The PDF wash: the same span the prose path paints, expressed as a needle
  // inside the spoken text — the page anchors on the sentence (the two
  // extraction pipelines disagree on whitespace) and paints the span within
  // it. At paragraph level the needle is the paragraph itself, since that is
  // what the wash covers. Trimmed up front so the anchor and the offsets share
  // one coordinate.
  const pdfWash = useMemo(() => {
    if (!isPdf || speechUnit === null) return null;
    const unit = speechQueue[speechUnit];
    if (!unit || !speechSpan || speechSpan.source !== unit.source) return null;
    // Block-local offsets against a needle that starts at the block's own zero
    // for a paragraph, and at the sentence's start for the others.
    const whole = speechGranularity === "paragraph";
    const raw = whole ? (chapterData?.paragraphs?.[unit.source] ?? unit.text) : unit.text;
    const origin = whole ? 0 : unit.start;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const from = Math.max(speechSpan.start - origin, lead) - lead;
    const to = Math.min(speechSpan.end - origin, raw.length - trail) - lead;
    const text = raw.trim();
    if (text.length === 0 || from < 0 || to <= from || to > text.length) return null;
    return { text, from, to };
  }, [isPdf, speechUnit, speechQueue, speechSpan, speechGranularity, chapterData]);
  // Kindle units exactly as foliate handed them out, so the follow effect can
  // resolve a unit index back to a block and a range inside the section. State
  // rather than a ref: the player renders their text as it comes in.
  const [mobiUnits, setMobiUnits] = useState<SpeechUnit[]>([]);

  // Set when the voice rolls off the end of a chapter, consumed by the
  // position effect below once the next chapter has rendered.
  const autoAdvance = useRef(false);

  const goTo = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(idx, chapters.length - 1));
      if (clamped === chapterIdx) return;
      // A chapter switch invalidates the paragraph queue the voice is walking.
      stop();
      setNav(clamped > chapterIdx ? 1 : -1);
      setChapterIdx(clamped);
      if (isPdf) {
        // A paged PDF has no scrollable overflow, so its fraction rides on
        // the page index; a later mode switch re-anchors on the same page.
        fractionRef.current = chapters.length > 1 ? clamped / (chapters.length - 1) : 0;
        if (layoutModeRef.current === "scroll" && pdfSlotH.current > 0) {
          const el = scrollRef.current;
          if (el) {
            // Position is set directly on the uniform slots; the upcoming
            // chapter load must not re-apply fraction 0 over it.
            suppressPdfPending.current = true;
            el.scrollTop = clamped * pdfSlotH.current;
          }
        }
      }
      pendingScroll.current = 0;
      if (!isPdf) fractionRef.current = 0;
      const progress = globalProgress(chapters, clamped, 0);
      setProgress({ progress });
      setDisplayProgress(progress);
      setFraction(0);
      setAutoScrolling(false);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [chapters, chapterIdx, isPdf, setProgress, stop],
  );

  /** Jumps to a fraction inside a chapter, used by bookmarks. */
  const jumpTo = useCallback(
    (idx: number, target: number) => {
      if (idx === chapterIdx) {
        const el = scrollRef.current;
        if (el) applyPosition(el, target, layoutModeRef.current, marginRef.current);
        fractionRef.current = target;
        setFraction(target);
        setDisplayProgress(globalProgress(chapters, idx, target));
        return;
      }
      goTo(idx);
      // `goTo` resets the pending fraction; restore ours after it.
      pendingScroll.current = target;
    },
    [chapterIdx, chapters, goTo],
  );

  const onChapterEnd = useCallback(() => {
    // A "read to the end of the chapter" timer ends the session here.
    if (sleepRef.current?.kind === "chapter") {
      sleepRef.current = null;
      setSleep(null);
      stop();
      return;
    }
    if (chapterIdx < chapters.length - 1) {
      autoAdvance.current = true;
      goTo(chapterIdx + 1);
    }
  }, [chapterIdx, chapters.length, goTo, stop]);

  // Set when the voice rolls off the end of a chapter, consumed by the
  // position effect below once the next chapter has rendered.
  const applyPending = useCallback(
    (el: HTMLDivElement) => {
      // A PDF page jump already scrolled the uniform slots directly; the
      // chapter load that follows must not land fraction 0 on top of it.
      if (suppressPdfPending.current) {
        suppressPdfPending.current = false;
        return;
      }
      const focus = pendingFocus.current;
      pendingFocus.current = null;
      const frac = pendingScroll.current;
      pendingScroll.current = 0;
      const paragraphs = chapterData?.paragraphs ?? [];
      const continueSpeech = autoAdvance.current;
      autoAdvance.current = false;
      if (continueSpeech) {
        play(
          speechQueue.map((unit) => unit.text),
          0,
          onChapterEnd,
        );
      }
      if (focus !== null) {
        const target = paragraphAt(paragraphs, focus);
        el.querySelector(`[data-para-idx="${target}"]`)?.scrollIntoView({ block: "center" });
        return;
      }
      applyPosition(el, frac, layoutModeRef.current, marginRef.current);
    },
    [chapterData, onChapterEnd, play, speechQueue],
  );

  // Apply the pending position once the chapter body has rendered: a search hit
  // scrolls its paragraph to the middle, otherwise the saved fraction applies.
  // Auto-advance rides along: the voice restarts at paragraph zero of the new
  // chapter inside the same frame the body appears.
  useEffect(() => {
    if (chapterData == null) return;
    const el = scrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      alignTail(el, layoutModeRef.current, marginRef.current, tailRef, setTail);
      applyPending(el);
    });
    return () => cancelAnimationFrame(frame);
  }, [chapterData, applyPending]);

  // Switching layout mode re-anchors the same reading position on the new axis.
  useEffect(() => {
    layoutModeRef.current = layoutMode;
    const el = scrollRef.current;
    if (layoutMode === "scroll" && tailRef.current !== null) {
      tailRef.current = null;
      setTail(null);
    }
    if (el) applyPosition(el, fractionRef.current, layoutMode, marginRef.current);
  }, [layoutMode]);

  // Keep the margin mirror fresh; margin is not needed for rendering effects.
  useEffect(() => {
    marginRef.current = marginX + (fullscreen ? FULLSCREEN_MARGIN_BONUS : 0);
  }, [fullscreen, marginX]);

  // Any typography or side-margin change re-flows the columns mid-read; the
  // viewport must re-anchor on the new pitch, otherwise it lands between column
  // boundaries and shows sliced-off slivers of the neighbouring pages. The
  // layout fingerprint skips the work when nothing that re-flows changed
  // (deps-array form trips exhaustive-deps: these inputs intentionally trigger
  // without being read inside).
  const reflowKeyRef = useRef("");
  useEffect(() => {
    const sideMargin = marginX + (fullscreen ? FULLSCREEN_MARGIN_BONUS : 0);
    const key = paged
      ? `${fontSize}|${lineHeightIdx}|${paraGapIdx}|${indent ? 1 : 0}|${settings.fontFamily}|${sideMargin}`
      : "";
    if (key === reflowKeyRef.current) return;
    reflowKeyRef.current = key;
    if (!paged) return;
    const el = scrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      alignTail(el, layoutModeRef.current, sideMargin, tailRef, setTail);
      applyPosition(el, fractionRef.current, layoutModeRef.current, sideMargin);
    });
    return () => cancelAnimationFrame(frame);
  });

  // Track the viewport width; paged modes lay the chapter out in columns and
  // re-anchor the position whenever the columns re-flow.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      // Sidebar spring: the article is pinned, the pane's per-frame width
      // changes must not re-wrap anything or re-render the page.
      if (pinnedRef.current !== null) return;
      setViewportW(el.clientWidth);
      setViewportH(el.clientHeight);
      if (layoutModeRef.current !== "scroll") {
        requestAnimationFrame(() => {
          alignTail(el, layoutModeRef.current, marginRef.current, tailRef, setTail);
          applyPosition(el, fractionRef.current, layoutModeRef.current, marginRef.current);
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Pin the article while a sidebar width spring (hide/show or collapse)
  // resizes the pane; subscribing to the store pins before React commits the
  // shell change, so no frame is ever laid out on an intermediate width.
  useEffect(() => {
    const release = () => {
      const el = scrollRef.current;
      pinnedRef.current = null;
      el?.style.removeProperty("overflow-x");
      setPinnedW(null);
      if (!el) return;
      setViewportW(el.clientWidth);
      if (layoutModeRef.current !== "scroll") {
        requestAnimationFrame(() => {
          alignTail(el, layoutModeRef.current, marginRef.current, tailRef, setTail);
          applyPosition(el, fractionRef.current, layoutModeRef.current, marginRef.current);
        });
      }
    };
    const freeze = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (pinnedRef.current === null) {
        const article = el.querySelector("article");
        pinnedRef.current = Math.round(article?.getBoundingClientRect().width || el.clientWidth);
        setPinnedW(pinnedRef.current);
        // A frozen article can be wider than the shrinking pane; the
        // transient horizontal scrollbar would be the only visual artifact.
        el.style.overflowX = "hidden";
      }
      if (pinReleaseRef.current !== null) window.clearTimeout(pinReleaseRef.current);
      pinReleaseRef.current = window.setTimeout(release, 450);
    };
    const unsubscribe = useSettings.subscribe((s, prev) => {
      if (s.sidebarHidden !== prev.sidebarHidden || s.sidebarCollapsed !== prev.sidebarCollapsed) {
        freeze();
      }
    });
    return () => {
      unsubscribe();
      if (pinReleaseRef.current !== null) window.clearTimeout(pinReleaseRef.current);
    };
  }, []);

  /** Flips one page in a paged layout; rolls into the neighbouring chapter at the edges. */
  const flip = useCallback(
    (dir: 1 | -1) => {
      if (isMobi) {
        // At the first/last page of the current section, roll explicitly into
        // the neighbouring section (foliate's implicit next()/prev() cross only
        // when its scroll probe reports the page edge, which is fragile);
        // otherwise turn the page normally. This makes "last page + next ->
        // next chapter" deterministic for keyboard paging.
        const handle = mobiRef.current;
        if (!handle) return;
        if (handle.atEdge(dir)) handle.section(dir);
        else handle.flip(dir);
        return;
      }
      const el = scrollRef.current;
      if (!el) return;
      if (isPdf) {
        // A PDF page fills the viewport exactly — there is no column to
        // slide, so a flip is a page step (two at a time in the spread).
        goTo(chapterIdx + dir * (layoutModeRef.current === "double" ? 2 : 1));
        return;
      }
      const max = el.scrollWidth - el.clientWidth;
      const pos = el.scrollLeft;
      if (dir === 1 && pos >= max - 2) {
        goTo(chapterIdx + 1);
        return;
      }
      if (dir === -1 && pos <= 2) {
        goTo(chapterIdx - 1);
        return;
      }
      // Snap to an exact column boundary: the viewport width includes the page
      // margins, so scrolling by clientWidth drifts and slices the next column.
      const mode = layoutModeRef.current;
      const margin = marginRef.current;
      const pitch = columnPitch(el, mode, margin);
      const page = pitch > 0 ? (mode === "double" ? 2 : 1) : 0;
      if (page === 0 || pitch <= 0) {
        flipPage(el, pos + dir * el.clientWidth, pageTransition, dir, reduce);
        return;
      }
      const target = (Math.round(pos / pitch) + dir * page) * pitch;
      flipPage(el, Math.max(0, Math.min(target, max)), pageTransition, dir, reduce);
    },
    [chapterIdx, goTo, isPdf, isMobi, pageTransition, reduce],
  );
  // The auto page turn reads `flip` from a timer; a ref keeps that timer from
  // restarting (and losing its place) every time `flip` is rebuilt.
  const flipRef = useRef(flip);
  useEffect(() => {
    flipRef.current = flip;
  }, [flip]);

  /** Chapter step; foliate's sections replace our chapter index for Kindle. */
  const stepChapter = useCallback(
    (dir: 1 | -1) => {
      if (isMobi) {
        mobiRef.current?.section(dir);
        return;
      }
      goTo(chapterIdx + dir);
    },
    [chapterIdx, goTo, isMobi],
  );

  // Trackpad pinch (macOS wheel events with ctrlKey set) zooms the PDF pages;
  // preventDefault keeps the browser's own page zoom out of the way.
  useEffect(() => {
    if (!isPdf) return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setPdfZoom((zoom) =>
        Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, zoom * Math.exp(-event.deltaY * 0.01))),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isPdf]);

  /** Button-driven zoom: glide the size over a beat; the pinch keeps its
      frame-by-frame directness by never setting the flag. */
  const stepPdfZoom = useCallback((factor: number) => {
    setPdfZoomAnimated(true);
    setPdfZoom((zoom) => Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, zoom * factor)));
  }, []);

  useEffect(() => {
    if (!pdfZoomAnimated) return;
    const timer = window.setTimeout(() => setPdfZoomAnimated(false), 260);
    return () => window.clearTimeout(timer);
  }, [pdfZoomAnimated]);

  // In paged modes the wheel flips whole pages instead of nudging pixels:
  // free pixel scrolling always ends between two columns. A zoomed PDF pans
  // natively instead, and a pinch scales rather than flips.
  useEffect(() => {
    if (layoutMode === "scroll") return;
    if (isPdf && pdfZoom !== 1) return;
    const el = scrollRef.current;
    if (!el) return;
    let acc = 0;
    let lastEventAt = 0;
    let flipped = false;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const now = performance.now();
      // One gesture = one page. Trackpad inertia keeps firing events long
      // after the flip, so a fixed cooldown would turn one swipe into two
      // pages; instead, only silence longer than GESTURE_GAP re-arms flipping.
      if (now - lastEventAt > GESTURE_GAP) {
        acc = 0;
        flipped = false;
      }
      lastEventAt = now;
      if (flipped) return;
      acc += event.deltaY + event.deltaX;
      if (Math.abs(acc) >= 48) {
        flip(acc > 0 ? 1 : -1);
        acc = 0;
        flipped = true;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [flip, isPdf, layoutMode, pdfZoom]);

  /** Toggles the operating-system fullscreen of the Tauri window. */
  const setReaderFullscreen = useChrome((s) => s.setReaderFullscreen);
  const toggleFullscreen = useCallback(async () => {
    let next: boolean;
    if (isDesktopRuntime) {
      try {
        const win = getCurrentWindow();
        next = !(await win.isFullscreen());
        await win.setFullscreen(next);
      } catch {
        // Permission or platform failure: degrade to hiding the chrome only.
        next = !fullscreen;
      }
    } else {
      next = !fullscreen;
    }
    setFullscreen(next);
    setReaderFullscreen(next);
  }, [fullscreen, setReaderFullscreen]);

  // The fullscreen exit hint pops when immersion starts and eases itself out
  // after a few seconds — discoverability without a permanent pill. Esc and
  // the header button keep working either way. Leaving fullscreen resets the
  // flag during render (the established render-time adjust pattern).
  const [exitPill, setExitPill] = useState(false);
  const [pillFor, setPillFor] = useState(fullscreen);
  if (pillFor !== fullscreen) {
    setPillFor(fullscreen);
    setExitPill(fullscreen);
  }
  useEffect(() => {
    if (!fullscreen) return;
    const timer = window.setTimeout(() => setExitPill(false), 3000);
    return () => window.clearTimeout(timer);
  }, [fullscreen]);

  // macOS can leave fullscreen without our toggle — the traffic-light green
  // dot or a native gesture. The window resize that follows is the only
  // signal, so re-read the real state on it and re-sync the chrome.
  useEffect(() => {
    if (!isDesktopRuntime) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void win
      .onResized(async () => {
        try {
          const actual = await win.isFullscreen();
          if (!disposed) {
            setFullscreen(actual);
            setReaderFullscreen(actual);
          }
        } catch {
          // Query failed; the next resize will retry.
        }
      })
      .then((unlistenFn) => {
        if (disposed) unlistenFn();
        else unlisten = unlistenFn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setReaderFullscreen]);

  // Keyboard paging.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (lightboxIdx !== null) {
        if (event.key === "Escape") {
          setLightboxIdx(null);
        } else if (event.key === "ArrowRight") {
          setLightboxIdx(Math.min(lightboxIdx + 1, bookImages.length - 1));
        } else if (event.key === "ArrowLeft") {
          setLightboxIdx(Math.max(lightboxIdx - 1, 0));
        } else {
          return;
        }
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" && panel !== "none") {
        if (panel === "search") setSearch("");
        setPanel("none");
        return;
      }
      if (event.key === "Escape" && fullscreen) {
        void toggleFullscreen();
        return;
      }
      // Don't hijack typing in any text field (search panel, etc.): a focused
      // input must keep its native caret/selection behaviour, and keys reaching
      // `window` from inside the book's iframe carry a `null` target so they are
      // never mistaken for an editable field here.
      const editing =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          event.target.tagName === "INPUT" ||
          event.target.tagName === "TEXTAREA" ||
          event.target.tagName === "SELECT");
      if (editing) return;
      if (paged && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        flip(event.key === "ArrowRight" ? 1 : -1);
        event.preventDefault();
        return;
      }
      if (event.key === "ArrowRight") {
        stepChapter(1);
        event.preventDefault();
      }
      if (event.key === "ArrowLeft") {
        stepChapter(-1);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    bookImages.length,
    flip,
    fullscreen,
    lightboxIdx,
    panel,
    paged,
    stepChapter,
    toggleFullscreen,
  ]);

  // Auto-scroll, scroll layout: advances the viewport down the flow until it
  // runs out. Sub-pixel per-frame steps are folded across frames (see
  // `foldScrollDelta`), otherwise slow speeds on high-refresh displays round
  // away to no movement. Paged layouts are handled by the auto page turn below.
  useEffect(() => {
    if (!autoScrolling || layoutMode !== "scroll") return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      if (layoutModeRef.current !== "scroll") {
        setAutoScrolling(false);
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const fold = foldScrollDelta(autoScrollSpeed, dt, carry);
      carry = fold.carry;
      if (isMobi) {
        // foliate owns the scrollport; the sub-pixel remainder rides its
        // composited transform so slow speeds still creep forward.
        const handle = mobiRef.current;
        if (!handle) {
          setAutoScrolling(false);
          return;
        }
        if (fold.delta !== 0) handle.scrollByPx(fold.delta, fold.carry);
        if (handle.bookEnd()) {
          setAutoScrolling(false);
          return;
        }
        raf = requestAnimationFrame(step);
        return;
      }
      const el = scrollRef.current;
      if (!el) {
        setAutoScrolling(false);
        return;
      }
      if (fold.delta !== 0) el.scrollTop += fold.delta;
      const max = el.scrollHeight - el.clientHeight;
      if (el.scrollTop >= max - 1) {
        setAutoScrolling(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoScrolling, autoScrollSpeed, isMobi, layoutMode]);

  // Auto-scroll, paged layouts: there is no continuous scrollport to nudge, so
  // the same control turns a page at a time — one screenful per interval at the
  // chosen reading speed. Without this the button sat permanently disabled
  // (the default layout is paged) and the feature read as broken.
  useEffect(() => {
    if (!autoScrolling || layoutMode === "scroll") return;
    const span = scrollRef.current?.[isMobi ? "clientHeight" : "clientWidth"] ?? 0;
    const interval = Math.min(
      20_000,
      Math.max(900, ((span || 800) / Math.max(autoScrollSpeed, 1)) * 1000),
    );
    const id = window.setInterval(() => {
      // Kindle: stop at the last page of the last section instead of turning
      // in place forever.
      if (isMobi && mobiRef.current?.bookEnd()) {
        setAutoScrolling(false);
        return;
      }
      flipRef.current(1);
    }, interval);
    return () => window.clearInterval(id);
  }, [autoScrolling, autoScrollSpeed, isMobi, layoutMode]);

  // Both settings live in refs inside the hook, which is what lets the player
  // hand them over inside its own click and restart immediately (see
  // `applySpeechSettings`). These keep the hook in step with anything that
  // changes them another way — a resolved default voice, a stored rate read at
  // launch — without restarting a session nobody is listening to.
  useEffect(() => {
    setRate(speechRate);
  }, [speechRate, setRate]);

  useEffect(() => {
    setVoice(effectiveVoice);
  }, [effectiveVoice, setVoice]);

  // An armed sleep timer is a plain timeout: the card renders the countdown
  // from the same deadline, so there is nothing to tick here.
  useEffect(() => {
    if (sleep?.kind !== "minutes") return;
    const id = window.setTimeout(
      () => {
        stop();
        setSleep(null);
      },
      Math.max(sleep.endsAt - Date.now(), 0),
    );
    return () => window.clearTimeout(id);
  }, [sleep, stop]);

  const chooseSleep = (choice: SleepChoice) => {
    if (choice === "off") {
      setSleep(null);
      return;
    }
    if (choice === "chapter") {
      setSleep({ kind: "chapter" });
      return;
    }
    setSleep({ kind: "minutes", minutes: choice, endsAt: Date.now() + choice * 60_000 });
  };

  /** The Kindle wash for a unit: the word the engine last reported, in the
   *  block's own coordinates. `null` while the engine has not said where the
   *  voice is — the page still follows the voice, but nothing is washed, so a
   *  sentence never flashes before its word lands. */
  const mobiWashSpan = useCallback(
    (index: number, unit: SpeechUnit) => washSpan(index, unit, speechBoundary, speechGranularity),
    [speechGranularity, speechBoundary],
  );

  // Follow the voice: `nearest` only scrolls when the paragraph is fully out
  // of view, so skimming ahead is never yanked back.
  useEffect(() => {
    if (!isMobi) {
      if (speechUnit === null) return;
      const source = speechQueue[speechUnit]?.source;
      if (source === undefined) return;
      scrollRef.current
        ?.querySelector(`[data-para-idx="${source}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    // Kindle: the read-aloud units are the section's own text blocks, and the
    // paginator both scrolls to one and washes it, so the line being read is
    // always visible. `null` means the voice stopped — drop the wash. A
    // word-level wash is not this effect's to paint: it lands with the
    // engine's first position report, below.
    const handle = mobiRef.current;
    if (speechUnit === null) {
      handle?.clearTts();
      return;
    }
    const unit = mobiUnits[speechUnit];
    if (!unit || !handle) return;
    if (speechGranularity === "word") {
      // The word washed a moment ago belongs to the sentence before this one.
      handle.clearTts();
      handle.focusUnit(unit, null);
      return;
    }
    // The unit is one sentence at every level; the paragraph level asks for the
    // whole block it sits in, whose extent only foliate knows.
    handle.focusUnit(
      unit,
      speechGranularity === "paragraph" ? "block" : { start: unit.start, end: unit.end },
    );
  }, [isMobi, speechUnit, speechQueue, mobiUnits, speechGranularity]);

  // Word-level narrowing: several of these land inside one sentence, so they
  // only re-wash the run — scrolling again for every word would jitter.
  useEffect(() => {
    if (!isMobi || speechGranularity !== "word") return;
    if (speechUnit === null || speechBoundary?.unit !== speechUnit) return;
    const unit = mobiUnits[speechUnit];
    if (!unit) return;
    const span = mobiWashSpan(speechUnit, unit);
    if (span) mobiRef.current?.paintSpan(unit, span);
  }, [isMobi, speechGranularity, speechUnit, speechBoundary, mobiUnits, mobiWashSpan]);

  /**
   * Read-aloud for Kindle books: one section at a time. foliate owns the
   * scrollport and the block list, so a finished section hands the voice to
   * the next one — there is no continuous chapter to walk like in prose.
   *
   * `fromSelection` starts at the sentence the reader picked instead of at the
   * first block on screen. `onFinish` is passed in rather than closed over so
   * the transport can reuse the section roll-over without capturing a stale
   * section.
   */
  const readMobiOnwards = useCallback(
    (onFinish: () => void, fromSelection = false) => {
      const handle = mobiRef.current;
      if (!handle) return;
      const reading = fromSelection ? handle.readFromSelection() : handle.readFrom();
      void reading.then((units) => {
        // Empty means the book ran out; `stop` leaves the voice where it ended.
        if (units.length === 0 || handle.bookEnd()) {
          stop();
          return;
        }
        setMobiUnits(units);
        play(
          units.map((unit) => unit.text),
          0,
          onFinish,
        );
      });
    },
    [play, stop],
  );

  /** The Kindle roll-over: finish this section, hand the voice to the next.
   *  Named as a function expression so it can hand itself to `readMobiOnwards`
   *  as the continuation while still being memoised: the restart below hangs
   *  off its identity, and a fresh one per render would rebuild that every
   *  time the voice moves. */
  const continueMobi = useCallback(
    function roll() {
      const handle = mobiRef.current;
      if (!handle || handle.bookEnd()) {
        stop();
        return;
      }
      handle.section(1);
      readMobiOnwards(roll);
    },
    [readMobiOnwards, stop],
  );

  /** The queue the voice is walking: prose units, or the Kindle section's. */
  const activeUnits = isMobi ? mobiUnits : speechQueue;

  /** Set when a rate or a voice changed while the voice was on hold: the
   *  utterance being held was spoken with the old settings, so the transport
   *  restarts it instead of playing it out. */
  const restartOnResume = useRef(false);

  /**
   * Restarts the voice where it is, under settings the engine has not applied.
   *
   * Both engines commit the clip they are speaking, so a new rate or voice can
   * only reach the reader on a fresh utterance; restarting at the position the
   * voice has got to — not at the top of the sentence — is what makes the
   * change land now rather than at the next sentence. Picking a held voice up
   * again runs through here too, which is why a paused status is not a refusal.
   *
   * The highlight level needs none of this: it decides how much text the wash
   * covers, and the queue the voice walks is always cut per sentence.
   */
  const restartSpeech = useCallback(() => {
    if (speechStatus === "idle" || speechUnit === null || !activeUnits[speechUnit]) return;
    const head = speechTrim?.unit === speechUnit ? speechTrim.trim : 0;
    const spot = boundaryAt();
    const trim = head + (spot !== null && spot.unit === speechUnit ? spot.charIndex : 0);
    setSpeechTrim(trim > 0 ? { unit: speechUnit, trim } : null);
    play(
      activeUnits.map((unit) => unit.text),
      speechUnit,
      isMobi ? continueMobi : onChapterEnd,
      trim,
    );
  }, [
    speechStatus,
    speechUnit,
    speechTrim,
    activeUnits,
    boundaryAt,
    play,
    isMobi,
    onChapterEnd,
    continueMobi,
  ]);

  /**
   * The player's two settings that only a fresh utterance can carry: both
   * engines commit the clip they are speaking. The change is handed to the
   * engine first — it reads both out of refs, so the restart already speaks at
   * the new rate and in the new voice — and the reading then carries on from
   * where the voice was.
   */
  const applySpeechSettings = (change: { rate?: number; voice?: string }) => {
    if (change.rate !== undefined) {
      settings.update({ speechRate: change.rate });
      setRate(change.rate);
    }
    if (change.voice !== undefined) {
      settings.update({ speechVoiceURI: change.voice });
      // Crossing engines cannot hand a queue over: `useTts` ends the session
      // rather than carrying on in a voice the reader just replaced.
      const crossed = engineOf(effectiveVoice) !== engineOf(change.voice);
      setVoice(change.voice);
      if (crossed) return;
    }
    // A voice that is on hold is restarted by the transport instead: the reader
    // gets the new setting when they pick the reading up again.
    if (speechStatus === "paused") {
      restartOnResume.current = true;
      return;
    }
    restartSpeech();
  };

  /** Jumps the voice to a unit — a transport step, or the scrubber. */
  const seekSpeech = (index: number) => {
    if (activeUnits.length === 0) return;
    const at = Math.max(0, Math.min(index, activeUnits.length - 1));
    // A transport jump always lands on an utterance boundary, so any head
    // trim left over from 「朗读此处」 no longer applies.
    setSpeechTrim(null);
    play(
      activeUnits.map((unit) => unit.text),
      at,
      isMobi ? continueMobi : onChapterEnd,
    );
  };

  /** One utterance. */
  const stepSpeech = (dir: 1 | -1) => {
    if (speechUnit === null) return;
    seekSpeech(speechUnit + dir);
  };

  /** One paragraph: the neighbouring run of units from a different block. */
  const skipSpeech = (dir: 1 | -1) => {
    if (speechUnit === null || activeUnits.length === 0) return;
    const source = activeUnits[speechUnit]?.source;
    if (dir === 1) {
      const next = activeUnits.findIndex((unit, at) => at > speechUnit && unit.source !== source);
      if (next >= 0) seekSpeech(next);
      return;
    }
    // Rewind to this block's own first unit, then to the start of the one
    // before it — the usual "previous track" behaviour.
    let head = speechUnit;
    while (head > 0 && activeUnits[head - 1]!.source === source) head -= 1;
    if (head === 0) return;
    const previous = activeUnits[head - 1]!.source;
    let target = head - 1;
    while (target > 0 && activeUnits[target - 1]!.source === previous) target -= 1;
    seekSpeech(target);
  };

  /**
   * Where the voice starts when the reader taps read-aloud: the paragraph on
   * screen, not the top of the chapter. A scrolled pane and a page column both
   * put the visible paragraph inside the scrollport's box, so one hit test
   * covers either layout. A PDF has no paragraph elements — its chapter *is*
   * the page on screen, so starting at zero is already the right page.
   */
  const unitAtView = (): number => {
    const el = scrollRef.current;
    const paragraphs = chapterData?.paragraphs ?? [];
    const pane = el?.getBoundingClientRect();
    if (!el || !pane) return 0;
    for (const node of el.querySelectorAll<HTMLElement>("[data-para-idx]")) {
      const box = node.getBoundingClientRect();
      if (
        box.bottom > pane.top + 4 &&
        box.top < pane.bottom &&
        box.right > pane.left &&
        box.left < pane.right
      ) {
        const idx = Number(node.dataset.paraIdx);
        return unitAtOffset(speechQueue, paragraphs, paragraphStart(paragraphs, idx));
      }
    }
    return 0;
  };

  const toggleSpeech = () => {
    if (speechStatus === "playing") {
      pause();
      return;
    }
    if (speechStatus === "paused") {
      // A rate or voice changed while on hold: those only reach the voice on a
      // fresh utterance, so pick the reading up again instead of playing the
      // held one out at the settings it was spoken with.
      if (restartOnResume.current) {
        restartOnResume.current = false;
        restartSpeech();
        return;
      }
      resume();
      return;
    }
    if (isMobi) {
      readMobiOnwards(continueMobi);
      return;
    }
    if (speechQueue.length > 0) {
      setSpeechTrim(null);
      play(
        speechQueue.map((unit) => unit.text),
        unitAtView(),
        onChapterEnd,
      );
    }
  };

  /**
   * 「朗读此处」: the voice picks up at the character the reader selected and
   * reads on from there, rather than restarting the chapter or restarting the
   * sentence the selection sits in.
   */
  const speakFromSelection = (range: TextRange) => {
    if (isMobi) {
      readMobiOnwards(continueMobi, true);
      return;
    }
    const paragraphs = chapterData?.paragraphs ?? [];
    // A PDF selection is measured against pdf.js's text layer, not the prose
    // we speak; locate the quoted text in the extracted page instead.
    const offset = isPdf ? Math.max(joinedText(paragraphs).indexOf(range.text), 0) : range.start;
    if (speechQueue.length === 0) return;
    const paragraph = paragraphAt(paragraphs, offset);
    const { index, trim } = cursorAt(
      speechQueue,
      paragraph,
      offset - paragraphStart(paragraphs, paragraph),
    );
    if (index < 0) return;
    setSpeechTrim(trim > 0 ? { unit: index, trim } : null);
    play(
      speechQueue.map((unit) => unit.text),
      index,
      onChapterEnd,
      trim,
    );
  };

  const saveProgress = useCallback(
    (frac: number) => {
      const progress = globalProgress(chapters, chapterIdx, frac);
      setProgress({ progress });
      // Every save marks the end of one reading session: fold it into the
      // sustained speed estimate that powers the remaining-time labels.
      const charsNow = progress * totalChars(chapters);
      const sample = { at: Date.now(), chars: charsNow };
      const last = speedSampleRef.current;
      speedSampleRef.current = sample;
      if (last) {
        const next = updateReadingSpeed(readingSpeed, charsNow - last.chars, sample.at - last.at);
        if (next !== readingSpeed) setReadingSpeed(next);
      }
    },
    [chapters, chapterIdx, readingSpeed, setProgress, setReadingSpeed],
  );

  const onScroll = useCallback(() => {
    setPending(null);
    const el = scrollRef.current;
    if (!el) return;
    const pagedNow = layoutModeRef.current !== "scroll";
    const max = pagedNow ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    const pos = pagedNow ? el.scrollLeft : el.scrollTop;
    const frac = max > 0 ? pos / max : 0;
    fractionRef.current = frac;
    setFraction(frac);
    setDisplayProgress(globalProgress(chapters, chapterIdx, frac));
    // In a scroll-layout PDF the page indicator follows the slot under the
    // top edge; chapterIdx stays pinned to the page it was entered from.
    const slot = pdfSlotH.current;
    if (isPdf && !pagedNow && slot > 0) {
      const page = Math.min(chapters.length, Math.floor(el.scrollTop / slot) + 1);
      setPdfScrollPage((prev) => (prev === page ? prev : page));
    }
    if (pagedNow && showPageNumbers) {
      const pitch = columnPitch(el, layoutModeRef.current, marginRef.current);
      if (pitch > 0) {
        const page = Math.round(el.scrollLeft / pitch) + 1;
        const pages = Math.round(max / pitch) + 1;
        setPageInfo((prev) =>
          prev && prev.page === page && prev.pages === pages ? prev : { page, pages },
        );
      }
    }
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => saveProgress(frac), SAVE_DELAY_MS);
  }, [chapters, chapterIdx, isPdf, saveProgress, showPageNumbers]);

  // Recompute the page indicator when the setting or layout flips without a
  // scroll event; chapter switches and resizes re-report through `onScroll`.
  useEffect(() => {
    // Kindle books are paginated by foliate inside their own scrollport, so
    // this host has no horizontal overflow to measure — running the formula
    // anyway reported a bogus "1 / 1", which then shadowed foliate's real
    // counter in the indicator.
    if (!paged || !showPageNumbers || isMobi) return;
    const el = scrollRef.current;
    if (!el) return;
    const pageMargin = marginX + (fullscreen ? FULLSCREEN_MARGIN_BONUS : 0);
    const pitch = columnPitch(el, layoutMode, pageMargin);
    const max = el.scrollWidth - el.clientWidth;
    if (pitch <= 0) return;
    setPageInfo({
      page: Math.round(el.scrollLeft / pitch) + 1,
      pages: Math.round(max / pitch) + 1,
    });
  }, [fullscreen, isMobi, layoutMode, marginX, paged, showPageNumbers]);

  // Flush a pending save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (mobiSaveRef.current !== null) window.clearTimeout(mobiSaveRef.current);
    };
  }, []);

  // A mouse-up over the article turns a completed selection into a pending
  // highlight, surfaced as a floating "高亮" button rather than saving blind.
  // The listener is attached through a ref so the reading viewport stays a plain
  // semantic scroll container instead of a synthetic widget.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onMouseUp = (event: MouseEvent) => {
      // A mouseup inside a PDF page's text layer belongs to that layer's own
      // handler — but a collapsed click there is a dismissal, same as over
      // prose: the layer's click handler only opens pills on annotation hits,
      // so without this the old pill would linger over the new tap.
      const target = event.target;
      if (target instanceof Element && target.closest("[data-pdf-layer]")) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) setPending(null);
        return;
      }
      const selection = window.getSelection();
      if (!selection || !chapterData) {
        setPending(null);
        return;
      }
      const range = resolveSelection(selection, chapterData.paragraphs);
      if (!range) {
        setPending(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setPending({ range, x: rect.left + rect.width / 2, y: rect.top });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [chapterData]);

  const createHighlight = (range: TextRange) => {
    createAnnotation.mutate(
      {
        chapterIdx: pending?.chapterIdx ?? chapterIdx,
        startChar: range.start,
        endChar: range.end,
        text: range.text,
        ...(pending?.cfi !== undefined ? { cfi: pending.cfi } : {}),
      },
      {
        onSuccess: () => {
          window.getSelection()?.removeAllRanges();
          setPending(null);
        },
      },
    );
  };

  /** Asks the assistant about the current selection. */
  const askAboutSelection = (range: TextRange) => {
    setAiContext(range.text);
    setPanel("ai");
    window.getSelection()?.removeAllRanges();
    setPending(null);
  };

  /** PDF text-layer selection: same pill, page-local offsets. */
  const onPdfSelection = useCallback((range: TextRange, rect: DOMRect, pageNumber: number) => {
    setPending({
      range,
      x: rect.left + rect.width / 2,
      y: rect.top,
      chapterIdx: pageNumber - 1,
    });
  }, []);

  /** Click on annotated text in the PDF: opens the pill in remove mode. */
  const onPdfAnnotationClick = useCallback(
    (annotation: Annotation, x: number, y: number, pageNumber: number) => {
      setPending({
        range: { start: annotation.startChar, end: annotation.endChar, text: annotation.text },
        x,
        y,
        annotationId: annotation.id,
        chapterIdx: pageNumber - 1,
      });
    },
    [],
  );

  /**
   * Kindle selection: foliate hands back a CFI, the only anchor that survives
   * a section change — the (chapter, offset) pair the prose path stores means
   * nothing here, because foliate's sections are the container's own.
   */
  const onFoliateSelection = useCallback((selection: FoliateSelection | null) => {
    if (!selection) {
      setPending(null);
      return;
    }
    setPending({
      range: { start: selection.startChar, end: selection.endChar, text: selection.text },
      x: selection.x,
      y: selection.y,
      chapterIdx: selection.section,
      cfi: selection.cfi,
    });
  }, []);

  /** Click on a painted Kindle highlight: reopen the pill in remove mode. */
  const onFoliateAnnotationClick = useCallback(
    (cfi: string, x: number, y: number) => {
      const annotation = (annotations ?? []).find((item) => item.cfi === cfi);
      if (!annotation) return;
      setPending({
        range: { start: annotation.startChar, end: annotation.endChar, text: annotation.text },
        x,
        y,
        annotationId: annotation.id,
        chapterIdx: annotation.chapterIdx,
        cfi,
      });
    },
    [annotations],
  );

  /** Reveals a character offset of the chapter already on screen. */
  const focusOffset = useCallback(
    (offset: number) => {
      const paragraphs = chapterData?.paragraphs;
      const el = scrollRef.current;
      if (!paragraphs || !el) return;
      const target = paragraphAt(paragraphs, offset);
      el.querySelector(`[data-para-idx="${target}"]`)?.scrollIntoView({ block: "center" });
    },
    [chapterData],
  );

  const pickHit = useCallback(
    (hit: SearchHit) => {
      if (hit.chapterIdx === chapterIdx) {
        focusOffset(hit.offset);
        return;
      }
      // Wait for the target chapter to render before scrolling to the match.
      pendingFocus.current = hit.offset;
      goTo(hit.chapterIdx);
    },
    [chapterIdx, focusOffset, goTo],
  );

  const navigate = useNavigate();

  /** Follows a RAG citation: scroll in this book, or open the other book. */
  const jumpToCitation = useCallback(
    (hit: RagHit) => {
      if (hit.bookId !== bookId) {
        navigate(`/reader?book=${hit.bookId}&chapter=${hit.chapterIdx}&at=${hit.startChar}`);
        return;
      }
      if (hit.chapterIdx === chapterIdx) {
        focusOffset(hit.startChar);
        return;
      }
      pendingFocus.current = hit.startChar;
      goTo(hit.chapterIdx);
    },
    [bookId, chapterIdx, focusOffset, goTo, navigate],
  );

  const total = chapters.length;
  const chapterTitle = chapterData?.title ?? "";
  // Each appearance keeps its own reading surface: a dark shell starts on the
  // night palette, and both stay user-changeable in the settings panel.
  const appTheme = useResolvedTheme();
  const surface = resolveSurface(
    appTheme === "dark" ? settings.nightSurface : surfaceKey,
    customSurface,
  );
  // Re-root the glass token set on the reading surface: the header, footer and
  // every glass control inside the reader tint themselves from the same ink
  // and paper colours, so a sepia page reads warm edge to edge instead of
  // clashing with the app chrome.
  const readerVars = {
    background: surface.background,
    ...readerGlassVars(surface),
  } as CSSProperties;
  // The night switch is independent of the paper surface: colours always come
  // from the night palette, so a light theme can ask for a dark PDF too. On a
  // dark surface this resolves to the active surface itself. `tint` is the
  // solid stand-in for `background`, which may be a gradient the canvas
  // cannot take.
  const nightPalette = resolveSurface(settings.nightSurface, customSurface);
  const pdfNight = pdfNightOn ? { fg: nightPalette.fg, bg: nightPalette.tint } : null;
  const fullscreenBonus = fullscreen ? FULLSCREEN_MARGIN_BONUS : 0;
  // 铺满屏幕: PDF pages meet the window edges like Preview; prose keeps the
  // user margins. Scroll slots and the spread padding both read from these.
  const margin = isPdf && pdfFill ? 0 : marginX + fullscreenBonus;
  const blockMargin = isPdf && pdfFill ? 0 : marginY + fullscreenBonus;

  // Typography and palette handed to the foliate renderer: the book keeps its
  // own CSS, the injected stylesheet wins over it for the reading settings.
  const foliateStyle = useMemo(
    () => ({
      fontSize,
      fontFamily: resolveFont(settings.fontFamily),
      lineHeight: LINE_HEIGHTS[lineHeightIdx] ?? 1.7,
      paraGap: PARA_GAPS[paraGapIdx] ?? 0.9,
      indent,
      fg: surface.fg,
      bg: surface.tint,
      // Same trigger as the PDF night path: the reading surface decides, not
      // the shell theme (surfaces are absolute).
      dark: surface.mode === "dark",
    }),
    [
      fontSize,
      lineHeightIdx,
      paraGapIdx,
      indent,
      settings.fontFamily,
      surface.fg,
      surface.mode,
      surface.tint,
    ],
  );
  // The TOC panel reads chapters; Kindle books are driven by foliate's own
  // TOC, so the entries are reshaped into the same shape (with nesting depth).
  const mobiChapters = useMemo(
    () =>
      foliateToc.map((entry, idx) => ({
        idx,
        title: entry.label,
        chars: 0,
        depth: entry.depth,
      })),
    [foliateToc],
  );
  const mobiTocIdx = useMemo(() => {
    const at = foliateToc.findIndex((entry) => entry.label === mobiSectionLabel);
    return at;
  }, [foliateToc, mobiSectionLabel]);

  /** Column width for the paged layouts; `undefined` keeps flow layout. */
  const columnWidth = useMemo(() => {
    if (!paged || viewportW <= 0) return undefined;
    const content = viewportW - margin * 2;
    return layoutMode === "double" ? (content - margin) / 2 : content;
  }, [layoutMode, margin, paged, viewportW]);

  const chapterRemaining = Math.max(
    0,
    Math.round((chapters[chapterIdx]?.chars ?? 0) * (1 - fraction)),
  );
  const bookRemaining = remainingChars(chapters, chapterIdx, fraction);

  // Bookmark state is derived, not flashed: the icon stays filled while the
  // reading position sits on a bookmark (same chapter, within 1% of chapter
  // length) and eases back once you scroll away — that is also the dedupe
  // signal, so tapping again on a bookmarked spot never stacks a duplicate.
  const bookmarkData = bookmarksQuery.data;
  const atBookmark = useMemo(
    () =>
      (bookmarkData ?? []).some(
        (bookmark) =>
          bookmark.chapterIdx === chapterIdx && Math.abs(bookmark.fraction - fraction) <= 0.01,
      ),
    [bookmarkData, chapterIdx, fraction],
  );

  const addBookmark = () => {
    const frac = fractionRef.current;
    const existing = (bookmarkData ?? []).find(
      (bookmark) =>
        bookmark.chapterIdx === chapterIdx && Math.abs(bookmark.fraction - frac) <= 0.01,
    );
    // Toggle: tapping a bookmarked spot again removes that bookmark.
    if (existing) {
      deleteBookmark.mutate(existing.id);
      return;
    }
    createBookmark.mutate({
      chapterIdx,
      fraction: frac,
      label: `${chapterTitle || `第 ${chapterIdx + 1} 章`} · ${Math.round(frac * 100)}%`,
    });
  };

  const transitionClass =
    pageTransition === "fade"
      ? "chapter-fade"
      : pageTransition === "paper"
        ? nav === 1
          ? "chapter-paper-fwd"
          : "chapter-paper-back"
        : pageTransition === "slide"
          ? nav === 1
            ? "chapter-slide-fwd"
            : "chapter-slide-back"
          : "";

  const articleStyle: CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily: resolveFont(settings.fontFamily),
    lineHeight: LINE_HEIGHTS[lineHeightIdx],
    // Wallpaper chapters read off the book's own paper art (light in both
    // themes), so the ink stays dark there instead of following the surface.
    color: wallpaperPath ? "#3f3629" : surface.fg,
    paddingInline: margin,
    paddingBlock: blockMargin,
    ...(columnWidth !== undefined
      ? {
          height: "100%",
          columnWidth,
          columnGap: margin,
          columnFill: "auto",
          // Page box for the `.paged-prose` image cap (see globals.css):
          // the measured scroller height beats any 100vh estimate. Only
          // inject a real measurement — a 0 would clamp the img cap to 0
          // and silently hide every picture.
          "--page-block": `${blockMargin}px`,
          ...(viewportH > 0 ? { "--page-h": `${viewportH}px` } : {}),
        }
      : {}),
    // Sidebar spring: frozen at the pre-animation width so the per-frame pane
    // resize never re-wraps the chapter (mx-auto keeps it centred).
    ...(pinnedW !== null ? { width: pinnedW } : {}),
  };

  // Split the chapter into paragraph segments, wrapping the parts covered by an
  // annotation, a search match or the reading voice in a highlight. Keys are
  // built here (outside the JSX map) so the render lists never use a raw index
  // key. Only the paragraph the voice is on gets the extra cut, so a word-level
  // wash re-renders one paragraph, not the chapter.
  const renderedParagraphs = useMemo(() => {
    const paragraphs = chapterData?.paragraphs ?? [];
    const chapterAnnotations = (annotations ?? []).filter((a) => a.chapterIdx === chapterIdx);
    const wash = speechSpan && isProseParagraph(paragraphs[speechSpan.source]) ? speechSpan : null;
    return paragraphs.map((paragraph, idx) => ({
      idx,
      key: `${chapterIdx}-${idx}`,
      // An image marker renders as the referenced picture; it has no text.
      imagePath: paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX)
        ? paragraph.slice(IMAGE_PARAGRAPH_PREFIX.length)
        : null,
      // A link marker renders as a tappable entry that jumps to the target
      // chapter (in-book tables of contents).
      link: paragraph.startsWith(LINK_PARAGRAPH_PREFIX) ? parseLinkParagraph(paragraph) : null,
      segments: highlightSegments(
        paragraphs,
        idx,
        chapterAnnotations,
        search,
        wash?.source === idx ? wash : undefined,
      ).map((segment, position) => ({
        key: `${chapterIdx}-${idx}-${position}`,
        text: segment.text,
        highlighted: segment.highlighted,
        annotationId: segment.annotationId,
        tts: segment.tts,
      })),
    }));
  }, [chapterData, chapterIdx, annotations, search, speechSpan]);

  // A plate chapter is a part-title page: the chapter's own wallpaper plus at
  // most a short heading, no running text. Kindle paints these pages with a
  // full-page CSS background; the multicol prose path would split the title
  // and the art across columns, so they get a dedicated page-shaped view.
  const plate = useMemo(() => {
    if (!wallpaperPath) return null;
    const text = (chapterData?.paragraphs ?? []).filter((paragraph) => paragraph !== "").join("\n");
    return text.length <= 30 ? { imagePath: wallpaperPath, title: text } : null;
  }, [chapterData, wallpaperPath]);

  // The wallpaper behind a text page (the copyright page's paper) loads once
  // per chapter; plates draw the art themselves, so skip the double fetch.
  // Kindle books paint their own paper inside the foliate view — the
  // extracted wallpaper would only layer underneath it.
  const wallpaperUrl = useAssetUrl(bookId, plate || isMobi ? null : wallpaperPath);

  // Reader chrome button: same anatomy as the sidebar's glass buttons, but
  // fill and hairline come from the re-rooted reading-surface tokens — the
  // fill is a wash of the paper colour (--glass-btn), so the circles read as
  // liquid glass over the page without darkening it like an ink fill would.
  const chromeBtn = "bg-(--glass-btn) border-hairline-strong shadow-glass";
  // Kindle sections replace the imported chapter list while reading, but only
  // when foliate actually found a TOC — an old MOBI6 has none.
  const useMobiToc = isMobi && foliateToc.length > 0;
  const headerIndex = useMobiToc
    ? mobiTocIdx + 1
    : isPdf && !paged && pdfScrollPage !== null
      ? pdfScrollPage
      : chapterIdx + 1;
  const headerTotal = useMobiToc ? foliateToc.length : total;
  const headerChapter = useMobiToc ? mobiSectionLabel : chapterTitle;

  // Shared header bar: rendered in flow normally, and dropped from the top
  // edge on hover while in fullscreen — where it also gets a surface-tinted
  // glass backdrop, since it then floats over pages of any colour.
  const headerBar = (
    <header
      className={cn(
        "border-hairline flex items-center gap-3 border-b px-6 py-3",
        fullscreen && "bg-(--glass-btn) backdrop-blur-xl",
      )}
    >
      <GlassIconButton label="返回书库" size="sm" onClick={onBack} className={chromeBtn}>
        <ArrowLeft size={16} />
      </GlassIconButton>
      <div className="min-w-0 flex-1">
        <p className="text-text-1 truncate text-sm font-medium">{title}</p>
        <p className="text-text-3 truncate text-xs">
          第 {headerIndex} / {headerTotal} {isPdf ? "页" : "章"}
          {!isPdf && headerChapter && ` · ${headerChapter}`}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <GlassIconButton
          label="目录与书签"
          size="sm"
          className={chromeBtn}
          onClick={() => setPanel((open) => (open === "toc" ? "none" : "toc"))}
        >
          <ListBullets size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="搜索"
          size="sm"
          className={chromeBtn}
          onClick={() => setPanel((open) => (open === "search" ? "none" : "search"))}
        >
          <MagnifyingGlass size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="标注"
          size="sm"
          className={chromeBtn}
          onClick={() => setPanel((open) => (open === "annotations" ? "none" : "annotations"))}
        >
          <HighlighterCircle size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="知识图谱"
          size="sm"
          className={chromeBtn}
          onClick={() => setPanel((open) => (open === "graph" ? "none" : "graph"))}
        >
          <Graph size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="阅读设置"
          size="sm"
          className={chromeBtn}
          onClick={() => setPanel((open) => (open === "settings" ? "none" : "settings"))}
        >
          <Faders size={16} />
        </GlassIconButton>
        {isPdf ? (
          // PDF pages are fixed bitmaps; the header steppers zoom the page.
          <>
            <GlassIconButton
              label="缩小页面"
              size="sm"
              className={chromeBtn}
              onClick={() => stepPdfZoom(1 / PDF_ZOOM_STEP)}
              disabled={pdfZoom <= MIN_PDF_ZOOM}
            >
              <Minus size={16} />
            </GlassIconButton>
            <GlassIconButton
              label="重置缩放"
              size="sm"
              className={chromeBtn}
              onClick={() => stepPdfZoom(1 / pdfZoom)}
            >
              <span className="text-[11px] font-semibold tabular-nums">
                {Math.round(pdfZoom * 100)}%
              </span>
            </GlassIconButton>
            <GlassIconButton
              label="放大页面"
              size="sm"
              className={chromeBtn}
              onClick={() => stepPdfZoom(PDF_ZOOM_STEP)}
              disabled={pdfZoom >= MAX_PDF_ZOOM}
            >
              <Plus size={16} />
            </GlassIconButton>
          </>
        ) : (
          <>
            <GlassIconButton
              label="缩小字号"
              size="sm"
              className={chromeBtn}
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= MIN_FONT_SIZE}
            >
              <span className="text-[11px] font-semibold">A</span>
            </GlassIconButton>
            <GlassIconButton
              label="放大字号"
              size="sm"
              className={chromeBtn}
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= MAX_FONT_SIZE}
            >
              <span className="text-sm font-semibold">A</span>
            </GlassIconButton>
          </>
        )}
        <GlassIconButton
          label={atBookmark ? "取消本书签" : "添加书签"}
          size="sm"
          className={chromeBtn}
          onClick={addBookmark}
          disabled={createBookmark.isPending || deleteBookmark.isPending}
        >
          {/* Remounting on state flip restarts the pop; the icon eases between
              outline and filled + accent instead of snapping. */}
          <span
            key={atBookmark ? "saved" : "idle"}
            className={cn(
              "inline-flex transition-colors duration-300",
              atBookmark && "text-accent animate-[bookmark-pop_0.45s_ease-out]",
            )}
          >
            <BookmarkSimple size={16} weight={atBookmark ? "fill" : "regular"} />
          </span>
        </GlassIconButton>
        <GlassIconButton
          label={fullscreen ? "退出全屏" : "全屏阅读"}
          size="sm"
          className={chromeBtn}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
        </GlassIconButton>
      </div>
    </header>
  );

  // Footer controls, shared by the in-flow bar and the fullscreen bottom hud.
  const footerInner = (
    <>
      <GlassIconButton
        label={
          speechStatus === "paused"
            ? "继续朗读"
            : speechStatus === "playing"
              ? "暂停朗读"
              : "从当前位置朗读"
        }
        size="sm"
        className={chromeBtn}
        onClick={toggleSpeech}
      >
        {speechStatus === "playing" ? <Pause size={16} /> : <SpeakerHigh size={16} />}
      </GlassIconButton>
      <GlassIconButton
        label="朗读播放器"
        size="sm"
        className={chromeBtn}
        onClick={() => setPlayerOpen((open) => !open)}
      >
        <span className="text-[11px] font-semibold tabular-nums">{speechRate}×</span>
      </GlassIconButton>
      <GlassIconButton
        label={
          paged
            ? autoScrolling
              ? "暂停自动翻页"
              : "开始自动翻页"
            : autoScrolling
              ? "暂停自动滚动"
              : "开始自动滚动"
        }
        size="sm"
        className={chromeBtn}
        onClick={() => setAutoScrolling((on) => !on)}
      >
        {autoScrolling ? <Pause size={16} /> : <ArrowDown size={16} />}
      </GlassIconButton>
      <GlassButton
        variant="subtle"
        size="sm"
        onClick={() => stepChapter(-1)}
        disabled={chapterIdx === 0}
      >
        <CaretLeft size={14} /> 上一章
      </GlassButton>
      <span className="text-text-3 text-xs">
        本章 {estimateLabel(chapterRemaining, readingSpeed)} · 全书{" "}
        {estimateLabel(bookRemaining, readingSpeed)}
      </span>
      <span className="text-text-3 text-xs">{Math.round(displayProgress * 100)}%</span>
      <GlassButton
        variant="subtle"
        size="sm"
        onClick={() => stepChapter(1)}
        disabled={chapterIdx >= total - 1}
      >
        下一章 <CaretRight size={14} />
      </GlassButton>
      <span className="text-text-3 text-xs">{paged ? "← → 翻页" : "← → 翻章"}</span>
    </>
  );

  return (
    <div className="flex h-full flex-col" style={readerVars}>
      {!fullscreen ? (
        headerBar
      ) : (
        // Fullscreen: the toolbar lives above the top edge and slides in only
        // while the pointer rests on the top strip of the reading area.
        <div className="group/hud absolute inset-x-0 top-0 z-40">
          <div className="-translate-y-full opacity-0 transition-all duration-200 ease-out group-hover/hud:translate-y-0 group-hover/hud:opacity-100 motion-reduce:transition-none">
            {headerBar}
          </div>
        </div>
      )}

      {/* Reading viewport. In paged modes the flip arrows reveal on hover or
          pointer-down and fade out after 2s, so they never sit on the text. */}
      <div
        className="relative flex min-h-0 flex-1"
        onMouseMove={revealFlipHintOnMove}
        onPointerDown={revealFlipHint}
        onMouseLeave={() => setFlipHint(false)}
      >
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn(
            "min-h-0 flex-1",
            // foliate owns its own scrolling and paging; giving the host a
            // scroll container of its own would double-clip the pages.
            isMobi
              ? "relative overflow-hidden"
              : paged
                ? isPdf && pdfZoom !== 1
                  ? "relative overflow-auto"
                  : "relative overflow-x-auto overflow-y-hidden"
                : isPdf && pdfZoom !== 1
                  ? "overflow-auto"
                  : "overflow-y-auto",
          )}
          // A chapter wallpaper (Kindle CSS page paper) paints the viewport
          // itself: the background stays put while pages slide over it, so
          // every page of the chapter reads as the same sheet of paper.
          style={{
            background: surface.background,
            ...(wallpaperUrl
              ? {
                  backgroundImage: `url(${wallpaperUrl})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }
              : {}),
          }}
        >
          {isPdf ? (
            // One page per chapter, drawn by pdf.js: fixed layout, real fonts
            // and illustrations. Deliberately outside the multicol prose
            // article: a page-sized canvas inside a column layout always
            // spills one column, which reads as a blank page after every page.
            paged ? (
              <div
                key={chapterIdx}
                className={cn(
                  "mx-auto flex h-full w-full items-stretch justify-center",
                  transitionClass,
                )}
                style={{ paddingInline: margin, paddingBlock: blockMargin, gap: pdfGap }}
              >
                <div className="h-full min-w-0 flex-1">
                  <Suspense fallback={<p className="text-sm opacity-60">正在准备 PDF 渲染…</p>}>
                    <PdfPageView
                      bookId={bookId}
                      pageNumber={chapterIdx + 1}
                      fit="box"
                      zoom={pdfZoom}
                      animated={pdfZoomAnimated}
                      nightFg={pdfNight?.fg ?? null}
                      nightBg={pdfNight?.bg ?? null}
                      invertImages={pdfInvertImages}
                      annotations={annotationsByPage.get(chapterIdx)}
                      ttsWash={pdfWash}
                      onSelection={(range, rect) => onPdfSelection(range, rect, chapterIdx + 1)}
                      onAnnotationClick={(annotation, x, y) =>
                        onPdfAnnotationClick(annotation, x, y, chapterIdx + 1)
                      }
                    />
                  </Suspense>
                </div>
                {layoutMode === "double" && chapterIdx + 1 < total && (
                  <div className="h-full min-w-0 flex-1">
                    <Suspense fallback={null}>
                      <PdfPageView
                        bookId={bookId}
                        pageNumber={chapterIdx + 2}
                        fit="box"
                        zoom={pdfZoom}
                        animated={pdfZoomAnimated}
                        nightFg={pdfNight?.fg ?? null}
                        nightBg={pdfNight?.bg ?? null}
                        invertImages={pdfInvertImages}
                        annotations={annotationsByPage.get(chapterIdx + 1)}
                        onSelection={(range, rect) => onPdfSelection(range, rect, chapterIdx + 2)}
                        onAnnotationClick={(annotation, x, y) =>
                          onPdfAnnotationClick(annotation, x, y, chapterIdx + 2)
                        }
                      />
                    </Suspense>
                  </div>
                )}
              </div>
            ) : (
              <Suspense fallback={<p className="text-sm opacity-60">正在准备 PDF 渲染…</p>}>
                <PdfScrollView
                  bookId={bookId}
                  numPages={total}
                  margin={margin}
                  blockMargin={blockMargin}
                  zoom={pdfZoom}
                  animated={pdfZoomAnimated}
                  nightFg={pdfNight?.fg ?? null}
                  nightBg={pdfNight?.bg ?? null}
                  invertImages={pdfInvertImages}
                  annotationsByPage={annotationsByPage}
                  ttsPage={chapterIdx}
                  ttsWash={pdfWash}
                  onSelection={onPdfSelection}
                  onAnnotationClick={onPdfAnnotationClick}
                  onLayout={handlePdfLayout}
                />
              </Suspense>
            )
          ) : isMobi ? (
            <Suspense fallback={<p className="text-text-3 p-6 text-sm">正在打开 Kindle 书籍…</p>}>
              <FoliateBookView
                ref={mobiRef}
                bookId={bookId}
                startCfi={startCfi}
                layout={layoutMode}
                transition={pageTransition}
                marginX={margin}
                marginY={blockMargin}
                style={foliateStyle}
                annotations={annotations}
                onSelect={onFoliateSelection}
                onAnnotationClick={onFoliateAnnotationClick}
                onLocationChange={rememberMobiLocation}
                onTocLoaded={setFoliateToc}
              />
            </Suspense>
          ) : paged && plate ? (
            // Part-title page: full-bleed wallpaper with the heading in a
            // centred plate, the way the book's own stylesheet paints it.
            // Outside the multicol article — a page-sized image inside a
            // column layout spills columns and reads as blank pages.
            <div
              key={chapterIdx}
              className={cn("mx-auto h-full w-full", transitionClass)}
              style={{ paddingInline: margin, paddingBlock: blockMargin }}
            >
              <div className="border-hairline relative h-full w-full overflow-hidden rounded-2xl">
                <ChapterImage
                  bookId={bookId}
                  path={plate.imagePath}
                  plate
                  onOpen={() => {
                    const imageNo = bookImages.findIndex(
                      (image) => image.chapterIdx === chapterIdx,
                    );
                    if (imageNo >= 0) setLightboxIdx(imageNo);
                  }}
                />
                {plate.title !== "" && (
                  // The book paints its part titles straight onto the art
                  // (ink on paper, no box); a light halo keeps the glyphs
                  // readable where the watercolour runs pale.
                  <div className="absolute inset-0 flex items-center justify-center">
                    <p
                      className="text-center text-lg font-medium tracking-[0.3em] whitespace-pre-line"
                      style={{ color: "#5a4632", textShadow: "0 1px 10px rgba(255,255,255,0.65)" }}
                    >
                      {plate.title}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <article
              key={chapterIdx}
              className={cn(
                "prose-reader mx-auto",
                !paged && "max-w-3xl",
                paged && "paged-prose",
                transitionClass,
              )}
              style={articleStyle}
            >
              {chapter.isPending ? (
                <p className="text-sm opacity-60">正在加载章节…</p>
              ) : (
                renderedParagraphs.map(({ idx, key, imagePath, link, segments }) =>
                  link !== null ? (
                    <p key={key} data-para-idx={idx} className="my-6">
                      <button
                        type="button"
                        onClick={() => goTo(link.idx)}
                        className="cursor-pointer underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-70"
                        style={{ color: "var(--accent)" }}
                      >
                        {link.text}
                      </button>
                    </p>
                  ) : imagePath !== null ? (
                    <p key={key} data-para-idx={idx} className="image-para my-6 text-center">
                      <ChapterImage
                        bookId={bookId}
                        path={imagePath}
                        onOpen={() => {
                          const imageNo = bookImages.findIndex(
                            (image) => image.chapterIdx === chapterIdx && image.path === imagePath,
                          );
                          if (imageNo >= 0) setLightboxIdx(imageNo);
                        }}
                      />
                    </p>
                  ) : (
                    <p
                      key={key}
                      data-para-idx={idx}
                      className="text-justify text-pretty"
                      style={{
                        marginBottom: `${PARA_GAPS[paraGapIdx]}em`,
                        textIndent: indent ? "2em" : undefined,
                        // Column layouts measure against real heights; dropping
                        // off-screen content corrupts the page boundaries.
                        ...(paged
                          ? {}
                          : { contentVisibility: "auto", containIntrinsicSize: "auto 3em" }),
                      }}
                    >
                      {segments.map((segment) =>
                        segment.tts ? (
                          // The reading voice's own run. Same ink as a saved
                          // mark — one wash, both reading paths.
                          <mark
                            key={segment.key}
                            className="bg-accent-soft rounded-[2px] text-inherit"
                          >
                            {segment.text}
                          </mark>
                        ) : segment.highlighted ? (
                          segment.annotationId ? (
                            // An annotation-backed run opens the same pill a
                            // fresh selection gets, with removal in place of
                            // creation. The wrapper is an anchor, not a
                            // `<button>`: buttons render as inline-block even
                            // with `display: inline`, and one atomic box
                            // breaks the paragraph's justified line breaking.
                            // A native anchor is focusable and Enter-clickable
                            // for free; the inner `<mark>` keeps the highlight
                            // semantics. A search match has nothing to open
                            // and stays a plain mark.
                            <a
                              key={segment.key}
                              href={`#note-${segment.annotationId}`}
                              className="cursor-pointer"
                              onClick={(event) => {
                                event.preventDefault();
                                const annotation = annotations?.find(
                                  (a) => a.id === segment.annotationId,
                                );
                                if (!annotation) return;
                                setPending({
                                  range: {
                                    start: annotation.startChar,
                                    end: annotation.endChar,
                                    text: annotation.text,
                                  },
                                  x: event.clientX,
                                  y: event.clientY,
                                  annotationId: annotation.id,
                                });
                              }}
                            >
                              <mark className="bg-accent-soft rounded-[2px] text-inherit">
                                {segment.text}
                              </mark>
                            </a>
                          ) : (
                            <mark
                              key={segment.key}
                              className="bg-accent-soft rounded-[2px] text-inherit"
                            >
                              {segment.text}
                            </mark>
                          )
                        ) : (
                          segment.text
                        ),
                      )}
                    </p>
                  ),
                )
              )}
            </article>
          )}
          {paged && tail && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 h-px"
              style={{ left: tail.left, width: tail.width }}
            />
          )}
        </div>

        {/* Page indicator (settings-gated) and a hairline progress rail that
            surfaces on activity and fades out after 2s of stillness. */}
        {paged && showPageNumbers && (isMobi ? mobiPage : pageInfo) && (
          <p
            className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 text-xs tabular-nums opacity-70"
            style={{ color: surface.fg }}
          >
            {(isMobi ? mobiPage : pageInfo)!.page} / {(isMobi ? mobiPage : pageInfo)!.pages} 页
          </p>
        )}
        {/* Quiet progress rail in the text colour: a barely-there track that
            never competes with the page, and a whisper fill while active. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-px"
          style={{ background: surface.fg, opacity: 0.08 }}
        />
        <div
          className={cn(
            "absolute bottom-0 left-0 z-10 h-px transition-opacity duration-300 motion-reduce:transition-none",
            flipHint ? "opacity-40" : "opacity-0",
          )}
          style={{
            width: `${Math.round(displayProgress * 100)}%`,
            background: surface.fg,
          }}
        />

        {paged && (
          <>
            <button
              type="button"
              aria-label="上一页"
              onClick={() => flip(-1)}
              className={cn(
                "glass-solid shadow-panel text-text-2 hover:text-text-1 absolute top-1/2 left-3 z-20",
                "flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
                "transition-all duration-200 motion-reduce:transition-none",
                flipHint ? "opacity-100" : "pointer-events-none -translate-x-1 opacity-0",
              )}
            >
              <CaretLeft size={16} />
            </button>
            <button
              type="button"
              aria-label="下一页"
              onClick={() => flip(1)}
              className={cn(
                "glass-solid shadow-panel text-text-2 hover:text-text-1 absolute top-1/2 right-3 z-20",
                "flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
                "transition-all duration-200 motion-reduce:transition-none",
                flipHint ? "opacity-100" : "pointer-events-none translate-x-1 opacity-0",
              )}
            >
              <CaretRight size={16} />
            </button>
          </>
        )}

        {/* Read-aloud: the pill while a session runs, the card on demand.
            Anchored inside the reading viewport rather than the window, so it
            clears the footer in the windowed chrome and still lands near the
            bottom edge in fullscreen. Neither takes a modal: the page stays
            readable under it, which is the point of reading along. */}
        <TtsPlayer
          open={playerOpen}
          onOpenChange={setPlayerOpen}
          title={title}
          coverUrl={coverUrl}
          chapter={headerChapter}
          units={activeUnits}
          index={speechUnit}
          status={speechStatus}
          error={speechError}
          rate={speechRate}
          onRate={(value) => applySpeechSettings({ rate: value })}
          voiceUri={effectiveVoice}
          onVoice={(uri) => applySpeechSettings({ voice: uri })}
          bookLanguage={bookLanguage}
          sleep={sleep}
          onSleep={chooseSleep}
          onToggle={toggleSpeech}
          onStop={stop}
          onStep={stepSpeech}
          onSkip={skipSpeech}
          onSeek={seekSpeech}
        />
      </div>

      {!fullscreen ? (
        <footer className="border-hairline flex items-center justify-center gap-3 border-t px-6 py-3">
          {footerInner}
        </footer>
      ) : (
        // Fullscreen: the function bar docks below the bottom edge and slides
        // up while the pointer rests on the bottom strip.
        <div className="group/hud-b absolute inset-x-0 bottom-0 z-40">
          <div className="h-7" aria-hidden />
          <div className="absolute inset-x-0 bottom-0 translate-y-full opacity-0 transition-all duration-200 ease-out group-hover/hud-b:translate-y-0 group-hover/hud-b:opacity-100 motion-reduce:transition-none">
            <footer className="border-hairline flex items-center justify-center gap-3 border-t bg-(--glass-btn) px-6 py-3 backdrop-blur-xl">
              {footerInner}
            </footer>
          </div>
        </div>
      )}

      {/* Fullscreen exit hint: pops on entering fullscreen, eases out after
          3s (see the exitPill effect). Non-interactive on purpose. */}
      {fullscreen && (
        <div
          aria-hidden={!exitPill}
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center",
            "transition-all duration-500 ease-out motion-reduce:transition-none",
            exitPill ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
          )}
        >
          <span className="glass-solid shadow-panel text-text-2 rounded-full px-4 py-1.5 text-xs">
            Esc 退出全屏
          </span>
        </div>
      )}

      {pending && (
        <div
          className="fixed z-40 -translate-x-1/2"
          style={{ left: pending.x, top: pending.y - 44 }}
        >
          {/* glass-solid, not glass-2: this pill floats over arbitrary page
              content — a white PDF page washes a blurred glass out entirely. */}
          <div className="glass-solid shadow-panel flex items-center overflow-hidden rounded-full">
            {pending.annotationId ? (
              <button
                type="button"
                onClick={() => {
                  deleteAnnotation.mutate(pending.annotationId!);
                  setPending(null);
                }}
                className="bg-accent text-on-accent px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
              >
                取消高亮
              </button>
            ) : (
              <button
                type="button"
                onClick={() => createHighlight(pending.range)}
                className="bg-accent text-on-accent px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
              >
                高亮
              </button>
            )}
            <button
              type="button"
              onClick={() => askAboutSelection(pending.range)}
              className="text-text-1 hover:text-accent border-hairline px-3 py-1.5 text-xs font-medium transition-colors"
            >
              问 AI
            </button>
            <button
              type="button"
              onClick={() => {
                speakFromSelection(pending.range);
                window.getSelection()?.removeAllRanges();
                setPending(null);
              }}
              className="text-text-1 hover:text-accent border-hairline px-3 py-1.5 text-xs font-medium transition-colors"
            >
              朗读此处
            </button>
            <button
              type="button"
              aria-label="取消"
              onClick={() => {
                window.getSelection()?.removeAllRanges();
                setPending(null);
              }}
              className="text-text-3 hover:text-text-1 px-2 py-1.5 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* One drawer at a time; AnimatePresence keeps it mounted while it
          slides out, and clicking the dimmed backdrop dismisses it. */}
      <AnimatePresence>
        {panel !== "none" && (
          <ReaderDrawer
            key="reader-drawer"
            title={
              panel === "toc"
                ? "目录与书签"
                : panel === "settings"
                  ? "阅读设置"
                  : panel === "annotations"
                    ? "标注"
                    : panel === "search"
                      ? "搜索正文"
                      : panel === "graph"
                        ? "知识图谱"
                        : "AI 助手"
            }
            onClose={() => {
              if (panel === "search") {
                setSearch("");
                // Drop the match highlights foliate painted into the pages.
                if (isMobi) mobiRef.current?.clearSearch();
              }
              setPanel("none");
            }}
          >
            {panel === "toc" && (
              <TocPanel
                chapters={useMobiToc ? mobiChapters : chapters}
                outline={outline}
                currentIdx={useMobiToc ? mobiTocIdx : chapterIdx}
                bookmarks={bookmarks ?? []}
                busy={createBookmark.isPending || deleteBookmark.isPending}
                onJump={(idx) => {
                  setPanel("none");
                  if (useMobiToc) {
                    mobiRef.current?.goToEntry(idx);
                    return;
                  }
                  goTo(idx);
                }}
                onJumpBookmark={(bookmark: Bookmark) => {
                  setPanel("none");
                  jumpTo(bookmark.chapterIdx, bookmark.fraction);
                }}
                onDeleteBookmark={(id) => deleteBookmark.mutate(id)}
                onAddBookmark={addBookmark}
              />
            )}
            {panel === "settings" && <SettingsPanel />}
            {panel === "annotations" && (
              <AnnotationList
                annotations={annotations ?? []}
                busy={deleteAnnotation.isPending}
                onDelete={(id) => deleteAnnotation.mutate(id)}
                onJump={
                  isMobi
                    ? (annotation) => {
                        setPanel("none");
                        if (annotation.cfi) mobiRef.current?.goToCfi(annotation.cfi);
                      }
                    : undefined
                }
              />
            )}
            {panel === "search" &&
              (isMobi ? (
                <FoliateSearchPanel
                  onSearch={(query) => mobiRef.current?.search(query) ?? Promise.resolve([])}
                  onPick={(cfi) => {
                    setPanel("none");
                    mobiRef.current?.goToCfi(cfi);
                  }}
                />
              ) : (
                <SearchPanel
                  bookId={bookId}
                  onPick={(hit, needle) => {
                    setSearch(needle);
                    pickHit(hit);
                  }}
                />
              ))}
            {panel === "graph" && (
              <GraphPanel
                bookId={bookId}
                onOpenChapter={(idx) => {
                  setPanel("none");
                  goTo(idx);
                }}
              />
            )}
            {panel === "ai" && (
              <AskAiPanel
                bookId={bookId}
                selection={aiContext}
                onClearSelection={() => setAiContext(null)}
                chapterTitle={chapterTitle || `第 ${chapterIdx + 1} 章`}
                paragraphs={chapterData?.paragraphs ?? []}
                onJump={jumpToCitation}
              />
            )}
          </ReaderDrawer>
        )}
      </AnimatePresence>

      {/* Lightbox viewer: blank areas close, Esc closes, arrows flip the book's images. */}
      <AnimatePresence>
        {lightboxIdx !== null && bookImages.length > 0 && (
          <ImageLightbox
            bookId={bookId}
            images={bookImages}
            chapters={chapters}
            index={Math.min(lightboxIdx, bookImages.length - 1)}
            onClose={() => setLightboxIdx(null)}
            onIndex={setLightboxIdx}
            onJump={(target) => {
              setLightboxIdx(null);
              goTo(target);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Fullscreen image viewer over the whole book's pictures. The image scales to
 * the available box (never touching the edges), the arrows step through the
 * book's images in reading order, and each one shows where it lives with a
 * one-click jump back to its chapter.
 */
function ImageLightbox({
  bookId,
  images,
  chapters,
  index,
  onClose,
  onIndex,
  onJump,
}: {
  bookId: string;
  images: BookImage[];
  chapters: ChapterMeta[];
  index: number;
  onClose: () => void;
  onIndex: (next: number) => void;
  onJump: (chapterIdx: number) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const current = images[index]!;
  const path = current.path;
  const location = chapters[current.chapterIdx]?.title ?? `第 ${current.chapterIdx + 1} 章`;

  // Viewer transform state: wheel/buttons zoom, the button spins, and a zoomed
  // picture pans by dragging. When the image changes, the render-time adjust
  // below resets everything for the new picture.
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  }

  // Wheel zoom needs a non-passive listener to be able to preventDefault.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((z) =>
        Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const clampPan = (value: { x: number; y: number }) => {
    const limit = 200 * zoom;
    return {
      x: Math.min(limit, Math.max(-limit, value.x)),
      y: Math.min(limit, Math.max(-limit, value.y)),
    };
  };

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        // The postMessage IPC fallback (active when the custom-protocol fetch
        // is unavailable) resolves byte arrays as plain JS arrays; normalize
        // before building the blob or it silently becomes a text blob.
        const bytes =
          buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
        url = URL.createObjectURL(new Blob([bytes], { type: assetMime(path) }));
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookId, path]);

  const arrowClass =
    "glass-solid shadow-panel text-text-1 flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-90";

  return (
    <motion.div
      ref={rootRef}
      className="fixed inset-0 z-[100] flex flex-col bg-black/85 p-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <button
        type="button"
        aria-label="关闭预览"
        className="absolute inset-0 cursor-zoom-out"
        onClick={onClose}
      />
      {/* Blank space passes through (pointer-events-none) to the close button
          underneath, so clicking anywhere outside the picture dismisses it. */}
      <div className="pointer-events-none relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {index > 0 && (
          <button
            type="button"
            aria-label="上一张"
            className={`${arrowClass} pointer-events-auto absolute top-1/2 left-2 z-10 -translate-y-1/2`}
            onClick={() => onIndex(index - 1)}
          >
            <CaretLeft size={16} />
          </button>
        )}
        {src && (
          <motion.img
            key={path}
            src={src}
            alt=""
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.18 }}
            className="shadow-panel pointer-events-auto max-h-full max-w-full rounded-xl object-contain"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              transition: dragging ? "none" : "transform 0.22s ease-out",
              cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
            draggable={false}
            onDoubleClick={() => {
              if (zoom > 1) {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              } else {
                setZoom(2.5);
              }
            }}
            onPointerDown={(event) => {
              if (zoom <= 1) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStartRef.current = {
                x: event.clientX,
                y: event.clientY,
                baseX: pan.x,
                baseY: pan.y,
              };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const drag = dragStartRef.current;
              if (!drag) return;
              setPan(
                clampPan({
                  x: drag.baseX + (event.clientX - drag.x),
                  y: drag.baseY + (event.clientY - drag.y),
                }),
              );
            }}
            onPointerUp={() => {
              dragStartRef.current = null;
              setDragging(false);
            }}
          />
        )}
        {index < images.length - 1 && (
          <button
            type="button"
            aria-label="下一张"
            className={`${arrowClass} pointer-events-auto absolute top-1/2 right-2 z-10 -translate-y-1/2`}
            onClick={() => onIndex(index + 1)}
          >
            <CaretRight size={16} />
          </button>
        )}
      </div>
      <div className="relative mt-5 flex flex-wrap items-center justify-center gap-3">
        <div className="glass-solid shadow-panel pointer-events-auto flex items-center gap-1 rounded-full p-1">
          <button
            type="button"
            aria-label="缩小"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
            className="text-text-1 flex h-7 w-7 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-30"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            aria-label="重置缩放与旋转"
            title="重置缩放与旋转"
            onClick={() => {
              setZoom(1);
              setRotation(0);
              setPan({ x: 0, y: 0 });
            }}
            className="text-text-1 w-12 text-center text-xs tabular-nums transition-opacity hover:opacity-80"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
            className="text-text-1 flex h-7 w-7 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-30"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="旋转 90 度"
            title="旋转 90 度"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="text-text-1 flex h-7 w-7 items-center justify-center rounded-full transition-opacity hover:opacity-80"
          >
            <ArrowClockwise size={14} />
          </button>
        </div>
        <span className="text-xs text-white/70 tabular-nums">
          {index + 1} / {images.length}
        </span>
        <span className="text-xs text-white/70">·</span>
        <button
          type="button"
          title="跳转到图片所在章节"
          onClick={() => onJump(current.chapterIdx)}
          className="text-xs text-white/70 underline-offset-4 transition-colors hover:text-white hover:underline"
        >
          第 {current.chapterIdx + 1} 章 · {location}
        </button>
        <a
          href={src ?? undefined}
          download={path.split("/").pop() || "image"}
          aria-disabled={!src}
          className="glass-solid shadow-panel text-text-1 flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs transition-opacity hover:opacity-90"
        >
          <DownloadSimple size={14} /> 保存图片
        </a>
        <button
          type="button"
          onClick={onClose}
          className="glass-solid shadow-panel text-text-2 hover:text-text-1 rounded-full px-4 py-1.5 text-xs transition-colors"
        >
          关闭（Esc）
        </button>
      </div>
    </motion.div>
  );
}

/** One question, one streamed answer. The context is the quoted selection when
 * there is one, otherwise the whole current chapter; the exchange restarts on
 * every drawer open, so nothing here needs clearing logic of its own. With
 * retrieval enabled the backend picks the context and returns citations.
 */
function AskAiPanel({
  bookId,
  selection,
  onClearSelection,
  chapterTitle,
  paragraphs,
  onJump,
}: {
  bookId: string;
  selection: string | null;
  onClearSelection: () => void;
  chapterTitle: string;
  paragraphs: string[];
  onJump: (hit: RagHit) => void;
}) {
  const [question, setQuestion] = useState("");
  const [ragMode, setRagMode] = useState(false);
  const ai = useAiChat();
  const status = useRagStatus(bookId);
  const indexBook = useIndexBook(bookId);

  const ragReady = (status.data?.embeddingModel ?? "") !== "";
  const thisBookIndexed = (status.data?.bookChunks ?? 0) > 0;

  const ask = () => {
    const trimmed = question.trim();
    if (!trimmed || ai.streaming) return;
    if (ragMode) {
      // Whole-library scope: `null` lets the backend search every indexed book.
      ai.askRag(trimmed, null);
      return;
    }
    const context = selection ?? paragraphs.join("\n");
    const content = selection
      ? `引用片段：\n${selection}\n\n问题：${trimmed}`
      : `当前章节：${chapterTitle}\n\n${context}\n\n问题：${trimmed}`;
    ai.send([{ role: "user", content }]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {selection && !ragMode && (
          <div className="border-hairline bg-surface-1 mb-3 rounded-lg p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-text-3 text-[11px]">引用片段</p>
              <button
                type="button"
                aria-label="清除引用"
                onClick={onClearSelection}
                className="text-text-3 hover:text-text-1 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
            <p className="text-text-2 line-clamp-4 text-[12.5px] leading-relaxed">{selection}</p>
          </div>
        )}

        {ai.error && <p className="text-danger mb-3 text-[12.5px] leading-relaxed">{ai.error}</p>}
        {ai.text && <p className="text-text-1 text-[13px] leading-relaxed">{ai.text}</p>}
        {ai.streaming && !ai.text && <p className="text-text-3 text-[12.5px]">正在思考…</p>}
        {!ai.text && !ai.streaming && !ai.error && (
          <p className="text-text-3 text-[13px] leading-relaxed">
            选中正文点「问 AI」可以针对片段提问；不带引用时，助手会读整章再回答。
          </p>
        )}

        {ai.citations.length > 0 && (
          <div className="border-hairline mt-3 border-t pt-3">
            <p className="text-text-3 mb-1.5 text-[11px]">来源</p>
            <ul className="space-y-1.5">
              {ai.citations.map((hit, index) => (
                <li key={`${hit.bookId}-${hit.chapterIdx}-${hit.startChar}`}>
                  <button
                    type="button"
                    onClick={() => onJump(hit)}
                    className="text-text-2 hover:text-accent w-full rounded-md text-left text-[12.5px] leading-relaxed transition-colors"
                  >
                    [{index + 1}] 《{hit.bookTitle}》 第 {hit.chapterIdx + 1} 章
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {ragReady && (
        <div className="border-hairline flex items-center justify-between gap-2 border-t px-3 py-2">
          <button
            type="button"
            aria-pressed={ragMode}
            onClick={() => setRagMode((on) => !on)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              ragMode
                ? "bg-accent text-on-accent border-transparent"
                : "border-hairline text-text-2 hover:text-text-1",
            )}
          >
            检索全书库
          </button>
          {ragMode && !thisBookIndexed && (
            <button
              type="button"
              disabled={indexBook.build.isPending}
              onClick={() => indexBook.build.mutate()}
              className="text-text-3 hover:text-text-1 text-[12px] transition-colors disabled:opacity-60"
            >
              {indexBook.build.isPending && indexBook.progress
                ? `索引中 ${indexBook.progress.done}/${indexBook.progress.total}`
                : "本书未索引，点此建立"}
            </button>
          )}
        </div>
      )}

      <form
        className="border-hairline flex items-center gap-2 border-t px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={
            ragMode ? "就全书内容提问…" : selection ? "就这段内容提问…" : "就本章内容提问…"
          }
          aria-label="问题"
          disabled={ai.streaming}
          className="border-hairline bg-surface-1 text-text-1 placeholder:text-text-3 focus-visible:border-accent h-8 min-w-0 flex-1 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={ai.streaming || question.trim() === ""}
          className="bg-accent text-on-accent rounded-full px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {ai.streaming ? "回答中" : "提问"}
        </button>
      </form>
    </div>
  );
}

/** MIME for an asset path extension; the webview only renders these. */
function assetMime(path: string): string {
  // Kindle image references declare their type inline: kindle:embed:…?mime=image/jpeg
  const declared = /[?&]mime=([\w/+.-]+)/.exec(path)?.[1];
  if (declared?.startsWith("image/")) return declared;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/jpeg";
}

/**
 * Blob URL for one in-book asset, fetched lazily from the source file. A null
 * path (no asset for this chapter) never touches the archive.
 */
function useAssetUrl(bookId: string, path: string | null): string | null {
  // Landed result keyed by its path: a null path never enters the effect, and
  // the render-time key check drops a stale URL the tick a path changes.
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        const bytes =
          buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
        url = URL.createObjectURL(new Blob([bytes], { type: assetMime(path) }));
        setLoaded({ path, url });
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookId, path]);
  return loaded && loaded.path === path ? loaded.url : null;
}

/**
 * One in-book image, fetched lazily from the source EPUB as a blob URL so a
 * chapter with no images never touches the archive. Clicking opens the
 * lightbox viewer.
 */
function ChapterImage({
  bookId,
  path,
  onOpen,
  plate = false,
}: {
  bookId: string;
  path: string;
  onOpen: (src: string) => void;
  /** Full-bleed wallpaper form for part-title pages: covers the page box. */
  plate?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        // The postMessage IPC fallback (active when the custom-protocol fetch
        // is unavailable) resolves byte arrays as plain JS arrays; normalize
        // before building the blob or it silently becomes a text blob.
        const bytes =
          buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
        url = URL.createObjectURL(new Blob([bytes], { type: assetMime(path) }));
        setSrc(url);
      })
      .catch(() => {
        // A silent failure here reads as a blank page; surface it.
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookId, path]);

  if (!src) {
    return failed ? <span className="text-sm opacity-50">图片加载失败:{path}</span> : null;
  }
  return (
    <button
      type="button"
      aria-label="查看图片"
      onClick={() => onOpen(src)}
      className={cn(
        "transition-opacity hover:opacity-90",
        plate ? "block h-full w-full cursor-zoom-in" : "cursor-zoom-in",
      )}
    >
      <img
        src={src}
        alt=""
        className={
          plate
            ? "h-full w-full object-cover"
            : "border-hairline mx-auto max-w-full rounded-lg border"
        }
        draggable={false}
      />
    </button>
  );
}

/** Right-hand drawer over a dimmed backdrop shared by every reader panel.
 * The backdrop click and the ✕ both dismiss; motion slides the sheet in from
 * the right edge and back out on close, gated by reduced motion. */
function ReaderDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <aside className="fixed inset-0 z-40">
      <motion.button
        type="button"
        aria-label="关闭面板"
        className="absolute inset-0 cursor-default bg-black/25"
        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.div
        className="absolute inset-y-0 right-0 w-80 max-w-[85vw] p-3"
        initial={reduce ? { opacity: 0 } : { x: "110%" }}
        animate={{ x: 0, opacity: 1 }}
        exit={reduce ? { opacity: 0 } : { x: "110%", opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 34 }}
      >
        <div className="glass-solid shadow-panel flex h-full flex-col rounded-2xl">
          <div className="border-hairline flex items-center justify-between border-b px-4 py-3">
            <p className="text-text-1 text-sm font-medium">{title}</p>
            <button
              type="button"
              aria-label={`关闭${title}`}
              onClick={onClose}
              className="text-text-3 hover:text-text-1 transition-colors"
            >
              <X size={15} />
            </button>
          </div>
          {children}
        </div>
      </motion.div>
    </aside>
  );
}

function AnnotationList({
  annotations,
  busy,
  onDelete,
  onJump,
}: {
  annotations: Annotation[];
  busy: boolean;
  onDelete: (id: string) => void;
  /**
   * Makes a row navigate to its highlight. Kindle books need it: their
   * highlights are anchored by CFI and the list cannot scroll a chapter that
   * was never on screen. Prose rows already sit in the chapter on screen.
   */
  onJump?: (annotation: Annotation) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {annotations.length === 0 ? (
        <p className="text-text-3 text-[13px] leading-relaxed">
          选中正文即可添加标注，标注会按章节归类在这里。
        </p>
      ) : (
        <ul className="space-y-3">
          {annotations.map((annotation) => (
            <li
              key={annotation.id}
              className="border-hairline border-b pb-3 last:border-0 last:pb-0"
            >
              <div className="flex items-start justify-between gap-2">
                {/* Kindle sections are the container's own, so the index this
                    list groups by is a section, not an imported chapter. */}
                <p className="text-text-3 text-xs">
                  第 {annotation.chapterIdx + 1}
                  {onJump ? " 节" : " 章"}
                </p>
                <button
                  type="button"
                  aria-label="删除标注"
                  disabled={busy}
                  onClick={() => onDelete(annotation.id)}
                  className="text-text-3 hover:text-danger transition-colors disabled:opacity-50"
                >
                  <Trash size={14} />
                </button>
              </div>
              {onJump ? (
                <button
                  type="button"
                  onClick={() => onJump(annotation)}
                  className="hover:bg-surface-1 -mx-1 mt-1 block w-full rounded-md px-1 py-0.5 text-left transition-colors"
                >
                  <p className="text-text-1 text-[13px] leading-relaxed">{annotation.text}</p>
                </button>
              ) : (
                <p className="text-text-1 mt-1 text-[13px] leading-relaxed">{annotation.text}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A non-negative integer query parameter, or `null` when absent or malformed. */
function readOffset(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function ReaderPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const bookId = searchParams.get("book");
  const initialChapter = readOffset(searchParams.get("chapter"));
  const initialOffset = readOffset(searchParams.get("at"));
  const initialQuery = searchParams.get("q") ?? "";

  const book = useBook(bookId);
  const toc = useReaderToc(bookId);

  const content = useMemo(() => {
    if (!bookId) {
      return (
        <EmptyState
          className="h-full"
          icon={<BookOpen size={26} weight="duotone" />}
          title="从书库选一本书"
          description="在书库里点开一本书，正文会出现在这里。"
        />
      );
    }
    if (book.isPending || toc.isPending) {
      return <p className="text-text-3 text-sm">正在打开…</p>;
    }
    if (book.isError || toc.isError) {
      return (
        <EmptyState
          className="h-full"
          icon={<BookOpen size={26} weight="duotone" />}
          title="这本书打不开"
          description="章节索引加载失败，回到书库重新导入试试。"
          action={
            <GlassButton variant="subtle" onClick={() => navigate("/")}>
              返回书库
            </GlassButton>
          }
        />
      );
    }
    return null;
  }, [bookId, book.isPending, book.isError, toc.isPending, toc.isError, navigate]);

  if (content) {
    return <div className="flex h-full flex-col px-8 py-6">{content}</div>;
  }

  const chapters = toc.data ?? [];
  const bookSummary = book.data;

  if (!bookId || !bookSummary || chapters.length === 0) {
    return (
      <div className="flex h-full flex-col px-8 py-6">
        <EmptyState
          className="h-full"
          icon={<BookOpen size={26} weight="duotone" />}
          title="这本书没有章节"
          description="这本书的格式暂时无法提取正文，重新导入可能可以解决。"
          action={
            <GlassButton variant="subtle" onClick={() => navigate("/")}>
              返回书库
            </GlassButton>
          }
        />
      </div>
    );
  }

  return (
    <ReaderView
      bookId={bookId}
      title={bookSummary.title}
      coverUrl={bookSummary.coverUrl}
      bookLanguage={bookSummary.language}
      format={bookSummary.format}
      chapters={chapters}
      initialProgress={bookSummary.progress}
      initialCfi={bookSummary.location}
      initialChapter={initialChapter}
      initialQuery={initialQuery}
      initialOffset={initialOffset}
      onBack={() => navigate("/")}
    />
  );
}
