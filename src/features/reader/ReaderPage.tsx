import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  Sparkle,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton, GlassIconButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { IconSwap } from "@/components/motion/IconSwap";
import { Reveal } from "@/components/motion/Reveal";
import { GraphPanel } from "@/features/graph/GraphPanel";
import { AnnotationList } from "@/features/reader/AnnotationList";
import { AskAiPanel } from "@/features/reader/AskAiPanel";
import { useAssetUrl } from "@/features/reader/assets";
import { ChapterImage } from "@/features/reader/ChapterImage";
import { GuidePanel } from "@/features/reader/GuidePanel";
import {
  usePdfZoom,
  MAX_PDF_ZOOM,
  MIN_PDF_ZOOM,
  PDF_ZOOM_STEP,
} from "@/features/reader/usePdfZoom";
import { useReaderFullscreen } from "@/features/reader/useReaderFullscreen";
import { FULLSCREEN_MARGIN_BONUS, useReaderLayout } from "@/features/reader/useReaderLayout";
import { HeaderCover, HeaderRule } from "@/features/reader/ReaderHeader";
import { applyPosition, columnPitch, flipPage } from "@/features/reader/paging";
import { ImageLightbox } from "@/features/reader/ImageLightbox";
import { ReaderDrawer } from "@/features/reader/ReaderDrawer";
import {
  bookPageAt,
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
  inkWash,
  joinedText,
  paragraphAt,
  paragraphStart,
  resolveSelection,
  selectionBottom,
  type TextRange,
} from "@/features/reader/selection";
import { SelectionOverlay, type LookupKind } from "@/features/reader/SelectionToolbar";
import type { AnnotationStyle } from "@/types/ipc";
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
  bundledFacesFor,
  fontFaceCss,
  resolveFont,
  resolveSurface,
  readerGlassVars,
} from "@/features/reader/theme";
import { SearchPanel } from "@/features/search/SearchPanel";
import {
  useAnnotations,
  useAnchorAnnotation,
  useCreateAnnotation,
  useDeleteAnnotation,
  useExportNotes,
  useSetAnnotationNote,
  useUpdateAnnotation,
} from "@/hooks/useAnnotations";
import { useBookmarks, useCreateBookmark, useDeleteBookmark } from "@/hooks/useBookmarks";
import { useResolvedTheme } from "@/hooks/useTheme";
import { useFonts } from "@/hooks/useFonts";
import {
  useBook,
  useBookImages,
  useChapter,
  usePdfOutline,
  useReaderToc,
  useSetProgress,
} from "@/hooks/useReader";
import { useReadingClock } from "@/hooks/useReading";
import {
  LINE_HEIGHTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  PARA_GAPS,
  foldScrollDelta,
  updateReadingSpeed,
  useReaderSettings,
  pageIsNight,
  HIGHLIGHT_COLORS,
} from "@/stores/reader";
import { boxOf, useBookHandoff } from "@/stores/book-handoff";
import { cn } from "@/lib/cn";
import type { PdfOutlineItem } from "@/lib/pdf";
import type {
  Annotation,
  BookFormat,
  BookImage,
  Bookmark,
  ChapterMeta,
  LocalFont,
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
/** The original-layout renderer; fetched for the two container formats it
 *  serves — Kindle (KF6/7/8) and EPUB (reflowable and fixed-layout). */
const FoliateBookView = lazy(() => import("@/features/reader/FoliateBookView"));
/** Notes export reaches for the native save dialog; kept out of the reader's
 *  own chunk so the reader still loads without it. */
const ExportNotesDialog = lazy(() =>
  import("@/features/reader/ExportNotesDialog").then((module) => ({
    default: module.ExportNotesDialog,
  })),
);

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

/**
 * Stand-in for the book's image list while the query is in flight. A fresh
 * `[]` per render would re-create every callback that reads it.
 */
const NO_IMAGES: BookImage[] = [];

/**
 * Stand-in for the imported fonts while the query is in flight. A fresh `[]`
 * per render would rebuild the stylesheet handed to foliate on every render.
 */
const NO_FONTS: LocalFont[] = [];

/**
 * Stand-in for a PDF's bookmark outline before (or without) the query. A fresh
 * `[]` per render would re-seed the TOC panel's fold state on every re-render,
 * collapsing whatever the reader had opened.
 */
const EMPTY_OUTLINE: PdfOutlineItem[] = [];

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
type Panel = "none" | "annotations" | "search" | "ai" | "guide" | "graph" | "toc" | "settings";

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
  /**
   * A highlight named by a `colorreader://` link the reader followed. Wins
   * over the saved position: following a link means "show me this", not
   * "carry on where I left off".
   */
  initialAnnotation: string | null;
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
  initialAnnotation,
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
    pageNumbers,
    pdfFill,
    pdfNight: pdfNightOn,
    pdfGap,
    pdfInvertImages,
    invertBookImages,
  } = settings;
  const speechRate = settings.speechRate;
  const speechVoiceURI = settings.speechVoiceURI;
  const speechGranularity = settings.speechGranularity;
  // The indicator is off, or it counts the unit the layout measured, or it
  // counts the whole book (`bookPageAt`). One flag for the two on-modes: the
  // measurement below is what both of them need.
  const showPages = pageNumbers !== "off";
  // Fullscreen mirrors the OS window rather than owning it: macOS can leave it
  // without us, so the real state has to be re-read on resize.
  const { fullscreen, exitHint, toggle: toggleFullscreen } = useReaderFullscreen();
  const reduce = useReducedMotion();
  const annotationsQuery = useAnnotations(bookId);
  const createAnnotation = useCreateAnnotation(bookId);
  const deleteAnnotation = useDeleteAnnotation(bookId);
  const updateAnnotation = useUpdateAnnotation(bookId);
  const anchorAnnotation = useAnchorAnnotation(bookId);
  const setAnnotationNote = useSetAnnotationNote(bookId);
  const bookmarksQuery = useBookmarks(bookId);
  const createBookmark = useCreateBookmark(bookId);
  const deleteBookmark = useDeleteBookmark(bookId);
  const exportNotes = useExportNotes();
  // Reading time: accumulates while this book is the open one and hands the
  // total to the backend once a minute.
  useReadingClock(bookId);
  // Destructure: each action is a stable useCallback, so effects that depend
  // on them individually never re-fire when speech state changes.
  const {
    status: speechStatus,
    unit: speechUnit,
    boundary: speechBoundary,
    error: speechError,
    loading: speechLoading,
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
  // Two renderers, one corpus. foliate keeps a book's own XHTML + CSS: for
  // KF8 that is the only faithful rendering (wallpapers, part-title plates,
  // inline art) and an EPUB asks for no less — so both containers go through
  // it. Everything else renders the extracted text: FB2 / CBZ / TXT / MD gain
  // nothing the text model cannot already do, and PDF renders through its own
  // pdf.js pipeline (foliate's PDF path is stubbed out). The chapters in the
  // database are the same either way, so search, TTS and AI never care which
  // renderer is on screen.
  const useFoliate = format === "mobi" || format === "epub";
  // A foliate position is a CFI, an opaque string our (chapter, fraction)
  // progress model cannot express. It rides in `books.location`; the
  // localStorage key it used to park in is read once as a fallback and
  // cleared the moment the database has the value.
  const cfiKey = `colorreader:foliate:${bookId}`;
  // The highlight a followed `colorreader://` link names. A link carries an id,
  // not a position, so the row has to be in hand before anything can be
  // anchored to it.
  const deepLinkTarget = useMemo(
    () =>
      initialAnnotation === null
        ? null
        : ((annotations ?? []).find((annotation) => annotation.id === initialAnnotation) ?? null),
    [annotations, initialAnnotation],
  );
  // foliate opens at a CFI or not at all, and a link's CFI only exists once the
  // annotation list has landed — the route holds the reader back until it has,
  // so this is settled by the time the view mounts. A link whose highlight is
  // gone, deleted, or never anchored falls through to the saved position,
  // which is the right degradation: the book still opens.
  const startCfi = useMemo(() => {
    if (!useFoliate) return null;
    return deepLinkTarget?.cfi ?? initialCfi ?? localStorage.getItem(cfiKey);
  }, [deepLinkTarget, initialCfi, useFoliate, cfiKey]);
  const outlineQuery = usePdfOutline(bookId, isPdf);
  const outline = outlineQuery.data ?? EMPTY_OUTLINE;
  const [panel, setPanel] = useState<Panel>("none");
  const [search, setSearch] = useState(initialQuery);
  const [pending, setPending] = useState<{
    range: TextRange;
    x: number;
    y: number;
    /** Bottom edge of the selection box, so the toolbar can sit right under it. */
    bottom?: number;
    annotationId?: string;
    /** The chapter (or PDF page, 0-based) the range belongs to; defaults to
     *  the chapter on screen. PDF selections set it — a two-page spread can
     *  surface a pill whose range lives on the other page. */
    chapterIdx?: number;
    /** The foliate CFI of this range. foliate sections do not line up with
     *  our chapter indices, so a mobi highlight is anchored by this instead. */
    cfi?: string;
  } | null>(null);
  // Quoted text for the AI drawer; `null` means "use the whole chapter".
  const [aiContext, setAiContext] = useState<string | null>(null);
  // Notes export: the format picker is open and waiting for a destination.
  const [exportingNotes, setExportingNotes] = useState(false);
  // 词典 / 翻译 / 维基百科 popup over the selection; `null` = closed. The
  // toolbar closes when it opens — one floating surface at a time.
  const [lookup, setLookup] = useState<{
    kind: LookupKind;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  // Query the search panel opens with (the toolbar's 搜索 action).
  const [searchSeed, setSearchSeed] = useState("");
  const [autoScrolling, setAutoScrolling] = useState(false);

  // A followed link into a book that renders as prose opens on the chapter that
  // quotes the passage. The chapter is all this path can promise: an
  // annotation's character offset counts the text the importer stored, not the
  // paragraphs the page actually paints, so scrolling by it would land nowhere
  // in particular. foliate books do better — they open at the mark itself.
  const linkedChapter = !useFoliate && deepLinkTarget ? deepLinkTarget.chapterIdx : null;
  // A chapter named in the URL wins over the saved position: arriving from a
  // search result means "open here", not "resume".
  const start = useMemo(
    () =>
      initialChapter !== null
        ? { idx: Math.min(initialChapter, chapters.length - 1), fraction: 0 }
        : linkedChapter !== null
          ? { idx: Math.min(linkedChapter, chapters.length - 1), fraction: 0 }
          : locateChapter(chapters, initialProgress),
    [chapters, initialProgress, initialChapter, linkedChapter],
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
  // open. foliate sections do not line up with the chapters our importer
  // extracts, so the TOC panel switches to this list while reading a mobi.
  const [foliateToc, setFoliateToc] = useState<FoliateTocEntry[]>([]);
  const [foliateSectionLabel, setFoliateSectionLabel] = useState("");
  /** Section page counter from foliate; feeds the same indicator as
   *  `pageInfo` (separate state because this one is declared earlier). */
  const [foliatePage, setFoliatePage] = useState<{ page: number; pages: number } | null>(null);
  /** How much of the book the section `foliatePage` counts lives in, 0..1.
   *  foliate sizes its sections by byte count, so this is the weight the
   *  whole-book page estimate needs. `null` until a section reports. */
  const [foliateSectionSpan, setFoliateSectionSpan] = useState<{
    start: number;
    end: number;
  } | null>(null);
  // Declared after the state it reports into (React Compiler forbids a
  // callback capturing a setter that is still initializing).
  const rememberFoliateLocation = useCallback(
    (location: FoliateLocation) => {
      // foliate reports true whole-book progress; our chapter-index estimate
      // (51 chapters of uneven length) drifts badly on Kindle files.
      setDisplayProgress(location.fraction);
      setFoliateSectionLabel(location.label);
      // foliate's sections are the container's own spine items; the importer
      // splits the same book by character count instead. The whole-book
      // fraction lands on the matching chapter, which is what the AI drawer
      // quotes and the remaining-time labels count from. Best effort: a book
      // whose empty spine documents were dropped at import shifts this by a
      // constant offset (ponytail: index by spine href once the importer
      // stores one).
      setChapterIdx(locateChapter(chapters, location.fraction).idx);
      // The section page counter feeds the same "N / M 页" indicator the
      // prose pager drives; null in the scroll layout clears it.
      setFoliatePage(location.page && { page: location.page.current, pages: location.page.total });
      setFoliateSectionSpan(location.sectionSpan);
      if (location.cfi === "") return;
      const cfi = location.cfi;
      if (foliateSaveRef.current !== null) window.clearTimeout(foliateSaveRef.current);
      foliateSaveRef.current = window.setTimeout(() => {
        // The CFI goes to the database, where it survives a cache clear and
        // travels with the library row; the old parking spot is retired.
        setProgress({ progress: location.fraction, location: cfi });
        localStorage.removeItem(cfiKey);
      }, SAVE_DELAY_MS);
    },
    [cfiKey, setProgress, chapters],
  );

  /** Continuous scroll vs paged single/double spread. */
  const paged = layoutMode !== "scroll";
  const scrollRef = useRef<HTMLDivElement>(null);
  // The foliate view, driven imperatively (see flip /
  // stepChapter): paging and sections never touch our chapter index.
  const foliateRef = useRef<FoliateHandle | null>(null);

  /**
   * Re-reads the live selection's box and moves the toolbar onto it.
   *
   * The toolbar is `position: fixed`, so anything that moves the page under it
   * — a wheel scroll, a page turn, a font that finished loading — leaves it
   * pointing at words that are no longer there. That reads as "the toolbar
   * sits a line away from what I selected", which no amount of care at
   * selection time can prevent. Both homes of a selection are covered: the
   * host document (prose, PDF text layer) and a foliate section iframe, whose
   * own `getSelection` the host cannot see.
   */
  const remeasureSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const domRange = selection.getRangeAt(0);
      const rect = domRange.getBoundingClientRect();
      const bottom = selectionBottom(domRange.getClientRects(), rect);
      const x = rect.left + rect.width / 2;
      setPending((prev) => {
        // Same object when nothing moved, so a scroll that does not carry the
        // selection costs no re-render of the whole reader.
        if (
          !prev ||
          (Math.abs(prev.x - x) < 1 &&
            Math.abs(prev.y - rect.top) < 1 &&
            Math.abs((prev.bottom ?? 0) - bottom) < 1)
        ) {
          return prev;
        }
        return { ...prev, x, y: rect.top, bottom };
      });
      return;
    }
    const box = foliateRef.current?.selectionBox();
    if (box) setPending((prev) => (prev?.cfi ? { ...prev, ...box } : prev));
  }, []);

  const toolbarOpen = pending !== null;
  useEffect(() => {
    if (!toolbarOpen) return;
    const el = scrollRef.current;
    el?.addEventListener("scroll", remeasureSelection, { passive: true });
    window.addEventListener("resize", remeasureSelection);
    return () => {
      el?.removeEventListener("scroll", remeasureSelection);
      window.removeEventListener("resize", remeasureSelection);
    };
  }, [toolbarOpen, remeasureSelection]);
  // Fraction to apply once the current chapter body has rendered. Starts at the
  // saved position, then is reset to the top of the chapter on navigation.
  const pendingScroll = useRef<number>(start.fraction);
  // Offset of a search hit to reveal instead of the scroll fraction.
  const pendingFocus = useRef<number | null>(initialOffset);
  const debounceRef = useRef<number | null>(null);
  // Pending debounce of the foliate position save (a CFI, so it only ever
  // carries the latest one — a page-turn storm must not queue a write each).
  const foliateSaveRef = useRef<number | null>(null);
  // Latest position along the active axis, read outside the scroll handler.
  const fractionRef = useRef<number>(start.fraction);
  // Everything about the column grid: measured viewport, the tail spacer and
  // the two mirrors every scroll callback reads (mode, applied margin).
  const { tail, measureTail, viewportW, viewportH, pinnedW, layoutModeRef, marginRef } =
    useReaderLayout({
      scrollRef,
      paged,
      layoutMode,
      marginX,
      fullscreen,
      fractionRef,
      fontSize,
      lineHeightIdx,
      paraGapIdx,
      indent,
      fontFamily: settings.fontFamily,
    });
  // Scroll-layout PDF bookkeeping: the slot height reported by PdfScrollView
  // maps pages to scroll offsets, the label follows the scrolled page, and the
  // suppress flag stops a page-jump's chapter load from re-applying position 0.
  const pdfSlotH = useRef(0);
  const suppressPdfPending = useRef(false);
  const [pdfScrollPage, setPdfScrollPage] = useState<number | null>(null);
  const {
    zoom: pdfZoom,
    animated: pdfZoomAnimated,
    step: stepPdfZoom,
  } = usePdfZoom(scrollRef, isPdf);
  // The scrolled-page label only means something in the scroll layout; reset
  // it when the layout flips (render-time adjust, the ImageLightbox pattern).
  const [prevPaged, setPrevPaged] = useState(paged);
  if (prevPaged !== paged) {
    setPrevPaged(paged);
    setPdfScrollPage(null);
  }
  const handlePdfLayout = useCallback(
    (slotHeight: number) => {
      pdfSlotH.current = slotHeight;
      // The scroll view mounts lazily (Suspense), after the layout-switch
      // effect has already run on an empty scroller; once the slots have real
      // heights, re-anchor the fraction so entering scroll mode keeps the page.
      if (slotHeight > 0 && layoutModeRef.current === "scroll") {
        const el = scrollRef.current;
        if (el) applyPosition(el, fractionRef.current, "scroll", marginRef.current);
      }
    },
    [layoutModeRef, marginRef],
  );
  /** Previous progress sample for the sustained reading speed estimate. */
  const speedSampleRef = useRef<{ at: number; chars: number } | null>(null);
  /** Hover-reveal flip affordance for paged modes; hides itself after 2s idle. */
  const [flipHint, setFlipHint] = useState(false);
  /** 1-based position inside the chapter's column count, for the page indicator. */
  const [pageInfo, setPageInfo] = useState<{ page: number; pages: number } | null>(null);
  /**
   * The page counter to print, in whichever unit the reader asked for — or
   * `null` to print nothing at all.
   *
   * `chapter` is what the layout measured; `book` is the estimate derived from
   * it (`bookPageAt`). Both paths hand that function the same two numbers — how
   * far into the book the unit starts, and how wide it is — measured on their
   * own units: the prose pager weighs chapters by character count, foliate by
   * the byte size of its sections.
   *
   * The `off` case is decided here rather than by a second flag at the render
   * site: the two on-modes share every measurement below, so a separate gate
   * would have to be kept in step with this one, and the first version of that
   * pairing showed a chapter counter while the setting said 隐藏.
   */
  const shownPages = useMemo(() => {
    if (pageNumbers === "off") return null;
    const unit = useFoliate ? foliatePage : pageInfo;
    if (unit === null) return null;
    if (pageNumbers !== "book") return { ...unit, estimated: false };

    let share: { before: number; span: number } | null = null;
    if (useFoliate) {
      if (foliateSectionSpan) {
        share = {
          before: foliateSectionSpan.start,
          span: foliateSectionSpan.end - foliateSectionSpan.start,
        };
      }
    } else {
      const chars = totalChars(chapters);
      if (chars > 0) {
        share = {
          before: globalProgress(chapters, chapterIdx, 0),
          span: (chapters[chapterIdx]?.chars ?? 0) / chars,
        };
      }
    }

    // No share to weigh by — a book with no chapter text, or a foliate book
    // whose TOC does not map onto the spine. The unit counter is still true, so
    // it stands in rather than the indicator going blank.
    const book = share ? bookPageAt(share.before, share.span, unit) : null;
    return book ? { ...book, estimated: true } : { ...unit, estimated: false };
  }, [useFoliate, foliatePage, foliateSectionSpan, pageInfo, pageNumbers, chapters, chapterIdx]);
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
  const bookImages = bookImagesQuery.data ?? NO_IMAGES;
  const fontsQuery = useFonts();
  const fonts = fontsQuery.data ?? NO_FONTS;
  // A picture clicked inside the book's own rendering. foliate reports the
  // archive entry it came from (see `FoliateBookView`), which is what the
  // book-wide list is keyed by; the entry itself is the lightbox's position.
  // An entry the importer skipped (rare: an image used only by the book's own
  // CSS) has no row here, and nothing opens.
  const openBookImage = useCallback(
    (path: string) => {
      const exact = bookImages.findIndex((image) => image.path === path);
      // The importer stores the entry name as it appears in the container
      // while foliate decodes percent escapes before resolving, so a CJK or
      // spaced filename can arrive spelled the two ways. Same file, same
      // basename — only the encoding differs.
      const decoded = (value: string) => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const index =
        exact >= 0
          ? exact
          : bookImages.findIndex(
              (image) =>
                image.path.slice(image.path.lastIndexOf("/") + 1) ===
                decoded(path).slice(path.lastIndexOf("/") + 1),
            );
      if (index >= 0) setLightboxIdx(index);
    },
    [bookImages],
  );

  // Read-aloud units for the prose path: the chapter split into sentences. The
  // foliate path builds its own from foliate's blocks, whose text lives in
  // another document. The reader's highlight level is not part of the cut (see
  // `speechUnits`), so changing it never recuts the queue under the voice.
  const speechQueue = useMemo(
    () => (useFoliate ? [] : speechUnits(speechSources(chapterData?.paragraphs ?? []))),
    [useFoliate, chapterData],
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
  // foliate units, exactly as foliate handed them out, so the follow effect can
  // resolve a unit index back to a block and a range inside the section. State
  // rather than a ref: the player renders their text as it comes in.
  const [foliateUnits, setFoliateUnits] = useState<SpeechUnit[]>([]);

  // Set when the voice rolls off the end of a chapter, consumed by the
  // position effect below once the next chapter has rendered.
  const autoAdvance = useRef(false);

  const goTo = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(idx, chapters.length - 1));
      if (useFoliate) {
        // The panels count chapters the importer's way; a foliate book is
        // navigated by whole-book fraction, the only anchor such an entry
        // carries once the container's own sections are on screen.
        const at = globalProgress(chapters, clamped, 0);
        stop();
        setChapterIdx(clamped);
        setFraction(0);
        setDisplayProgress(at);
        setAutoScrolling(false);
        foliateRef.current?.goToFraction(at);
        return;
      }
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
    [chapters, chapterIdx, isPdf, layoutModeRef, setProgress, stop, useFoliate],
  );

  /** Jumps to a fraction inside a chapter, used by bookmarks. */
  const jumpTo = useCallback(
    (idx: number, target: number) => {
      if (useFoliate) {
        const at = globalProgress(chapters, idx, target);
        setChapterIdx(idx);
        setFraction(target);
        setDisplayProgress(at);
        foliateRef.current?.goToFraction(at);
        return;
      }
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
    [chapterIdx, chapters, goTo, layoutModeRef, marginRef, useFoliate],
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
    [chapterData, layoutModeRef, marginRef, onChapterEnd, play, speechQueue],
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
      measureTail(el);
      applyPending(el);
    });
    return () => cancelAnimationFrame(frame);
  }, [chapterData, applyPending, measureTail]);

  /** Flips one page in a paged layout; rolls into the neighbouring chapter at the edges. */
  const flip = useCallback(
    (dir: 1 | -1) => {
      if (useFoliate) {
        // At the first/last page of the current section, roll explicitly into
        // the neighbouring section (foliate's implicit next()/prev() cross only
        // when its scroll probe reports the page edge, which is fragile);
        // otherwise turn the page normally. This makes "last page + next ->
        // next chapter" deterministic for keyboard paging.
        const handle = foliateRef.current;
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
    [chapterIdx, goTo, isPdf, layoutModeRef, marginRef, useFoliate, pageTransition, reduce],
  );
  // The auto page turn reads `flip` from a timer; a ref keeps that timer from
  // restarting (and losing its place) every time `flip` is rebuilt.
  const flipRef = useRef(flip);
  useEffect(() => {
    flipRef.current = flip;
  }, [flip]);

  /** Chapter step; foliate's sections replace our chapter index for foliate books. */
  const stepChapter = useCallback(
    (dir: 1 | -1) => {
      if (useFoliate) {
        foliateRef.current?.section(dir);
        return;
      }
      goTo(chapterIdx + dir);
    },
    [chapterIdx, goTo, useFoliate],
  );

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
      if (event.key === "Escape") {
        // One floating surface at a time: a lookup closes before any panel.
        if (lookup) {
          setLookup(null);
          return;
        }
        if (pending) {
          window.getSelection()?.removeAllRanges();
          setPending(null);
          return;
        }
        if (panel !== "none") {
          if (panel === "search") setSearch("");
          setPanel("none");
          return;
        }
        if (fullscreen) {
          void toggleFullscreen();
        }
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
    lookup,
    panel,
    paged,
    pending,
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
      if (useFoliate) {
        // foliate owns the scrollport; the sub-pixel remainder rides its
        // composited transform so slow speeds still creep forward.
        const handle = foliateRef.current;
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
  }, [autoScrolling, autoScrollSpeed, useFoliate, layoutMode, layoutModeRef]);

  // Auto-scroll, paged layouts: there is no continuous scrollport to nudge, so
  // the same control turns a page at a time — one screenful per interval at the
  // chosen reading speed. Without this the button sat permanently disabled
  // (the default layout is paged) and the feature read as broken.
  useEffect(() => {
    if (!autoScrolling || layoutMode === "scroll") return;
    const span = scrollRef.current?.[useFoliate ? "clientHeight" : "clientWidth"] ?? 0;
    const interval = Math.min(
      20_000,
      Math.max(900, ((span || 800) / Math.max(autoScrollSpeed, 1)) * 1000),
    );
    const id = window.setInterval(() => {
      // foliate: stop at the last page of the last section instead of turning
      // in place forever.
      if (useFoliate && foliateRef.current?.bookEnd()) {
        setAutoScrolling(false);
        return;
      }
      flipRef.current(1);
    }, interval);
    return () => window.clearInterval(id);
  }, [autoScrolling, autoScrollSpeed, useFoliate, layoutMode]);

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

  /** The foliate wash for a unit: the word the engine last reported, in the
   *  block's own coordinates. `null` while the engine has not said where the
   *  voice is — the page still follows the voice, but nothing is washed, so a
   *  sentence never flashes before its word lands. */
  const foliateWashSpan = useCallback(
    (index: number, unit: SpeechUnit) => washSpan(index, unit, speechBoundary, speechGranularity),
    [speechGranularity, speechBoundary],
  );

  // Follow the voice: `nearest` only scrolls when the paragraph is fully out
  // of view, so skimming ahead is never yanked back.
  useEffect(() => {
    if (!useFoliate) {
      if (speechUnit === null) return;
      const source = speechQueue[speechUnit]?.source;
      if (source === undefined) return;
      scrollRef.current
        ?.querySelector(`[data-para-idx="${source}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    // foliate: the read-aloud units are the section's own text blocks, and the
    // paginator both scrolls to one and washes it, so the line being read is
    // always visible. `null` means the voice stopped — drop the wash. A
    // word-level wash is not this effect's to paint: it lands with the
    // engine's first position report, below.
    const handle = foliateRef.current;
    if (speechUnit === null) {
      handle?.clearTts();
      return;
    }
    const unit = foliateUnits[speechUnit];
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
  }, [useFoliate, speechUnit, speechQueue, foliateUnits, speechGranularity]);

  // Word-level narrowing: several of these land inside one sentence, so they
  // only re-wash the run — scrolling again for every word would jitter.
  useEffect(() => {
    if (!useFoliate || speechGranularity !== "word") return;
    if (speechUnit === null || speechBoundary?.unit !== speechUnit) return;
    const unit = foliateUnits[speechUnit];
    if (!unit) return;
    const span = foliateWashSpan(speechUnit, unit);
    if (span) foliateRef.current?.paintSpan(unit, span);
  }, [useFoliate, speechGranularity, speechUnit, speechBoundary, foliateUnits, foliateWashSpan]);

  /**
   * Read-aloud for foliate books: one section at a time. foliate owns the
   * scrollport and the block list, so a finished section hands the voice to
   * the next one — there is no continuous chapter to walk like in prose.
   *
   * `fromSelection` starts at the sentence the reader picked instead of at the
   * first block on screen. `onFinish` is passed in rather than closed over so
   * the transport can reuse the section roll-over without capturing a stale
   * section.
   */
  const readFoliateOnwards = useCallback(
    (onFinish: () => void, fromSelection = false) => {
      const handle = foliateRef.current;
      if (!handle) return;
      const reading = fromSelection ? handle.readFromSelection() : handle.readFrom();
      void reading.then((units) => {
        // Empty means the book ran out; `stop` leaves the voice where it ended.
        if (units.length === 0 || handle.bookEnd()) {
          stop();
          return;
        }
        setFoliateUnits(units);
        play(
          units.map((unit) => unit.text),
          0,
          onFinish,
        );
      });
    },
    [play, stop],
  );

  /** The foliate roll-over: finish this section, hand the voice to the next.
   *  Named as a function expression so it can hand itself to `readFoliateOnwards`
   *  as the continuation while still being memoised: the restart below hangs
   *  off its identity, and a fresh one per render would rebuild that every
   *  time the voice moves. */
  const continueFoliate = useCallback(
    function roll() {
      const handle = foliateRef.current;
      if (!handle || handle.bookEnd()) {
        stop();
        return;
      }
      handle.section(1);
      readFoliateOnwards(roll);
    },
    [readFoliateOnwards, stop],
  );

  /** The queue the voice is walking: prose units, or the foliate section's. */
  const activeUnits = useFoliate ? foliateUnits : speechQueue;

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
      useFoliate ? continueFoliate : onChapterEnd,
      trim,
    );
  }, [
    speechStatus,
    speechUnit,
    speechTrim,
    activeUnits,
    boundaryAt,
    play,
    useFoliate,
    onChapterEnd,
    continueFoliate,
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
      useFoliate ? continueFoliate : onChapterEnd,
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
    if (useFoliate) {
      readFoliateOnwards(continueFoliate);
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
    if (useFoliate) {
      readFoliateOnwards(continueFoliate, true);
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
    if (pagedNow && showPages) {
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
  }, [chapters, chapterIdx, isPdf, layoutModeRef, marginRef, saveProgress, showPages]);

  // Recompute the page indicator when the setting or layout flips without a
  // scroll event; chapter switches and resizes re-report through `onScroll`.
  useEffect(() => {
    // foliate books are paginated inside their own scrollport, so
    // this host has no horizontal overflow to measure — running the formula
    // anyway reported a bogus "1 / 1", which then shadowed foliate's real
    // counter in the indicator.
    if (!paged || !showPages || useFoliate) return;
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
  }, [fullscreen, useFoliate, layoutMode, marginX, paged, showPages]);

  // Flush a pending save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (foliateSaveRef.current !== null) window.clearTimeout(foliateSaveRef.current);
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
      const domRange = selection.getRangeAt(0);
      const rect = domRange.getBoundingClientRect();
      setPending({
        range,
        x: rect.left + rect.width / 2,
        y: rect.top,
        bottom: selectionBottom(domRange.getClientRects(), rect),
      });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [chapterData]);

  const createHighlight = (
    range: TextRange,
    color: string,
    style: AnnotationStyle,
    /** Runs with the new row. The note path hangs its note on the id here,
     *  inside the same round trip the highlight was created in. */
    onCreated?: (created: Annotation) => void,
  ) => {
    createAnnotation.mutate(
      {
        chapterIdx: pending?.chapterIdx ?? chapterIdx,
        startChar: range.start,
        endChar: range.end,
        text: range.text,
        color,
        style,
        ...(pending?.cfi !== undefined ? { cfi: pending.cfi } : {}),
      },
      {
        onSuccess: (created) => {
          // The ink becomes the reader's default, so the next highlight
          // starts where this one left off.
          settings.update({ highlightColor: color, highlightStyle: style });
          window.getSelection()?.removeAllRanges();
          setPending(null);
          if (created) onCreated?.(created);
        },
      },
    );
  };

  /** Restyles an existing highlight (the toolbar's edit mode). */
  const restyleHighlight = (id: string, color: string, style: AnnotationStyle) => {
    updateAnnotation.mutate({ id, color, style });
    settings.update({ highlightColor: color, highlightStyle: style });
  };

  /** Copies the selection and dismisses the toolbar. */
  const copySelection = () => {
    void navigator.clipboard.writeText(pending?.range.text ?? "").catch(() => {
      // Clipboard can be denied; the toolbar stays open either way.
    });
  };

  /** Searches the selection in the book: opens the panel, query pre-filled. */
  const searchSelection = () => {
    if (!pending) return;
    setSearchSeed(pending.range.text.trim());
    setPanel("search");
    window.getSelection()?.removeAllRanges();
    setPending(null);
  };

  /** 词典 / 翻译 / 维基百科 popup anchored where the toolbar was. */
  const openLookup = (kind: LookupKind) => {
    if (!pending) return;
    setLookup({ kind, text: pending.range.text.trim(), x: pending.x, y: pending.y });
    setPending(null);
  };

  /** Asks the assistant about the current selection. */
  const askAboutSelection = (range: TextRange) => {
    setAiContext(range.text);
    setPanel("ai");
    window.getSelection()?.removeAllRanges();
    setPending(null);
  };

  /** PDF text-layer selection: same pill, page-local offsets. */
  const onPdfSelection = useCallback(
    (range: TextRange, rect: DOMRect, pageNumber: number, bottom: number) => {
      setPending({
        range,
        x: rect.left + rect.width / 2,
        y: rect.top,
        bottom,
        chapterIdx: pageNumber - 1,
      });
    },
    [],
  );

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
   * foliate selection: the view hands back a CFI, the only anchor that survives
   * a section change — the (chapter, offset) pair the prose path stores means
   * nothing here, because foliate's sections are the container's own.
   */
  const onFoliateSelection = useCallback((selection: FoliateSelection | null) => {
    setLookup(null);
    if (!selection) {
      setPending(null);
      return;
    }
    setPending({
      range: { start: selection.startChar, end: selection.endChar, text: selection.text },
      x: selection.x,
      y: selection.y,
      bottom: selection.bottom,
      chapterIdx: selection.section,
      cfi: selection.cfi,
    });
  }, []);

  /** Click on a painted foliate highlight: reopen the pill in remove mode. */
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

  /**
   * Stores the anchor a foliate-rendered highlight was missing.
   *
   * An import from a Kindle clippings file only knows the text it quotes, so its
   * row lands without a CFI and foliate has nothing to paint. The view finds the
   * text once the section carrying it is on screen and hands the CFI here; the
   * row is the same highlight it was a moment ago, now paintable.
   */
  const onFoliateAnchor = useCallback(
    (id: string, cfi: string) => anchorAnnotation.mutate({ id, cfi }),
    [anchorAnnotation],
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
    // The page palette is the reader's own choice now, not the app theme's:
    // see `pageTheme` in the reader store. `follow` keeps the old coupling.
    pageIsNight(settings.pageTheme, appTheme === "dark") ? settings.nightSurface : surfaceKey,
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
      // Inverting a book's pictures is the reader's call, not the surface's.
      invertImages: invertBookImages,
      // A section is its own document, so the faces have to travel with the
      // sheet rather than come from the app's own style — the imported ones
      // and the ones the app ships (霞鹜文楷), which is the difference between
      // the reader picking it and the reader getting the system 楷体.
      fontFaces: [fontFaceCss(fonts), bundledFacesFor(settings.fontFamily)]
        .filter(Boolean)
        .join("\n"),
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
      invertBookImages,
      fonts,
    ],
  );
  // The TOC panel reads chapters; foliate books are driven by its own
  // TOC, so the entries are reshaped into the same shape (with nesting depth).
  const foliateChapters = useMemo(
    () =>
      foliateToc.map((entry, idx) => ({
        idx,
        title: entry.label,
        chars: 0,
        depth: entry.depth,
      })),
    [foliateToc],
  );
  const foliateTocIdx = useMemo(() => {
    const at = foliateToc.findIndex((entry) => entry.label === foliateSectionLabel);
    return at;
  }, [foliateToc, foliateSectionLabel]);

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
          bookmark.chapterIdx === chapterIdx &&
          Math.abs((bookmark.fraction ?? 0) - fraction) <= 0.01,
      ),
    [bookmarkData, chapterIdx, fraction],
  );

  const addBookmark = () => {
    const frac = fractionRef.current;
    const existing = (bookmarkData ?? []).find(
      (bookmark) =>
        bookmark.chapterIdx === chapterIdx && Math.abs((bookmark.fraction ?? 0) - frac) <= 0.01,
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
      ).map((segment, position) => {
        // Annotation-backed runs carry their own ink; the toolbar's palette
        // decides what they look like.
        const owned = segment.annotationId
          ? annotations?.find((a) => a.id === segment.annotationId)
          : undefined;
        return {
          key: `${chapterIdx}-${idx}-${position}`,
          text: segment.text,
          highlighted: segment.highlighted,
          annotationId: segment.annotationId,
          tts: segment.tts,
          color: owned?.color ?? null,
          style: owned?.style ?? null,
        };
      }),
    }));
  }, [chapterData, chapterIdx, annotations, search, speechSpan]);

  /**
   * Inline ink for one prose-path annotation run: the translucent wash, the
   * straight line or the squiggle, in the annotation's colour. `null` colour
   * means a legacy highlight — the palette's marker yellow.
   */
  const markInk = useCallback(
    (color: string | null, style: AnnotationStyle | null): CSSProperties => {
      const hex = color ?? HIGHLIGHT_COLORS[0]!.hex;
      if ((style ?? "highlight") === "underline") {
        return {
          textDecoration: "underline",
          textDecorationColor: hex,
          textDecorationThickness: 2,
          textUnderlineOffset: "3px",
        };
      }
      if (style === "squiggly") {
        return {
          textDecoration: "underline wavy",
          textDecorationColor: hex,
          textDecorationThickness: 1.5,
          textUnderlineOffset: "3px",
        };
      }
      // Dark paper needs a lighter hand; the foliate overlay uses the same
      // two alphas, so one highlight reads the same on every path.
      return {
        backgroundColor: inkWash(hex, surface.mode === "dark" ? 0.26 : 0.36),
        borderRadius: 2,
      };
    },
    [surface.mode],
  );

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
  // foliate books paint their own paper inside the view — the
  // extracted wallpaper would only layer underneath it.
  const wallpaperUrl = useAssetUrl(bookId, plate || useFoliate ? null : wallpaperPath);

  // Reader chrome button: same anatomy as the sidebar's glass buttons, but
  // fill and hairline come from the re-rooted reading-surface tokens — the
  // fill is a wash of the paper colour (--glass-btn), so the circles read as
  // liquid glass over the page without darkening it like an ink fill would.
  const chromeBtn = "bg-(--glass-btn) border-hairline-strong shadow-glass";

  // Leaving the reader hands the cover back to the shelf — the same object
  // that flew in, in the other direction. The header thumbnail is the origin;
  // the shelf tile the book came from registers itself as the landing while it
  // mounts (`BookCard`), and until then `BookCoverFlight` carries it on its own
  // and dissolves if nothing ever lands. Under reduced motion the flight clears
  // the handoff instead of running it, so the shelf tile is never left blank.
  const coverBoxRef = useRef<HTMLSpanElement>(null);
  const beginHandoff = useBookHandoff((s) => s.begin);
  const leaveReader = () => {
    const cover = reduce ? null : coverBoxRef.current;
    if (cover) beginHandoff({ id: bookId, coverUrl, from: boxOf(cover), side: "reader" });
    onBack();
  };
  // foliate sections replace the imported chapter list while reading, but only
  // when foliate actually found a TOC — an old MOBI6 has none.
  const useFoliateToc = useFoliate && foliateToc.length > 0;
  const headerIndex = useFoliateToc
    ? foliateTocIdx + 1
    : isPdf && !paged && pdfScrollPage !== null
      ? pdfScrollPage
      : chapterIdx + 1;
  const headerTotal = useFoliateToc ? foliateToc.length : total;
  const headerChapter = useFoliateToc ? foliateSectionLabel : chapterTitle;

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
      <GlassIconButton label="返回书库" size="sm" onClick={leaveReader} className={chromeBtn}>
        <ArrowLeft size={16} />
      </GlassIconButton>
      <HeaderCover bookId={bookId} coverUrl={coverUrl} boxRef={coverBoxRef} />
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
        <HeaderRule />
        <GlassIconButton
          label="知识图谱"
          size="sm"
          className={chromeBtn}
          onClick={() => setPanel((open) => (open === "graph" ? "none" : "graph"))}
        >
          <Graph size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="AI 导读"
          size="sm"
          className={chromeBtn}
          onClick={() => setPanel((open) => (open === "guide" ? "none" : "guide"))}
        >
          <Sparkle size={16} />
        </GlassIconButton>
        <HeaderRule />
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
        <HeaderRule />
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
        <IconSwap state={speechStatus}>
          {speechStatus === "playing" ? <Pause size={16} /> : <SpeakerHigh size={16} />}
        </IconSwap>
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
        <IconSwap state={autoScrolling ? "on" : "off"}>
          {autoScrolling ? <Pause size={16} /> : <ArrowDown size={16} />}
        </IconSwap>
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
      {/* The readout pops as it changes: progress arriving silently next to
          buttons that all respond reads as frozen, not as steady. */}
      <motion.span
        key={Math.round(displayProgress * 100)}
        initial={{ opacity: 0.35 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="text-text-3 text-xs tabular-nums"
      >
        {Math.round(displayProgress * 100)}%
      </motion.span>
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

  // The toolbar's edit mode: when the reader tapped a painted highlight,
  // `pending` carries its id — resolve it to the whole annotation so the ink
  // row can show (and change) what it is painted with.
  const pendingAnnotation = pending?.annotationId
    ? ((annotations ?? []).find((annotation) => annotation.id === pending.annotationId) ?? null)
    : null;

  /**
   * The toolbar's note field. A note hangs off a highlight, so a bare
   * selection gets one first — painted in the ink the toolbar is showing,
   * which is also what the reader's next selection starts from.
   *
   * Clearing never creates anything: an empty field over an un-highlighted
   * passage is a thought the reader changed their mind about, not a request
   * for an invisible annotation.
   */
  const noteOnSelection = (note: string | null) => {
    if (!pending) return;
    if (pendingAnnotation) {
      if (note !== pendingAnnotation.note) {
        setAnnotationNote.mutate({ id: pendingAnnotation.id, note });
      }
      setPending(null);
      return;
    }
    if (note === null) {
      setPending(null);
      return;
    }
    createHighlight(pending.range, settings.highlightColor, settings.highlightStyle, (created) =>
      setAnnotationNote.mutate({ id: created.id, note }),
    );
  };

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
        data-reading-viewport
        className="relative flex min-h-0 flex-1"
        onMouseMove={revealFlipHintOnMove}
        onPointerDown={revealFlipHint}
        onMouseLeave={() => setFlipHint(false)}
      >
        <div
          ref={scrollRef}
          data-reading-content
          onScroll={onScroll}
          className={cn(
            "min-h-0 flex-1",
            // foliate owns its own scrolling and paging; giving the host a
            // scroll container of its own would double-clip the pages.
            useFoliate
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
            // The prose path pins its `<article>`; foliate has no article, so
            // the host itself is what has to hold its width while the sidebar
            // spring runs. foliate re-paginates the whole book whenever its
            // element is resized, and a per-frame re-pagination of a whole
            // book is what made collapsing or hiding the sidebar janky — the
            // pin turns ~30 re-paginations into one, after the spring settles.
            //
            // `flexBasis`, not `width`: this box is `flex-1`, so its
            // `flex-basis` is `0%` and a `width` on a flex item with a
            // definite basis is ignored outright — the width pin was silently
            // doing nothing. `flexGrow`/`flexShrink` have to go to 0 as well,
            // or the box grows straight back to the pane's new width.
            ...(pinnedW !== null && useFoliate
              ? { flexGrow: 0, flexShrink: 0, flexBasis: pinnedW }
              : {}),
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
                      onSelection={(range, rect, bottom) =>
                        onPdfSelection(range, rect, chapterIdx + 1, bottom)
                      }
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
                        onSelection={(range, rect, bottom) =>
                          onPdfSelection(range, rect, chapterIdx + 2, bottom)
                        }
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
          ) : useFoliate ? (
            <Suspense fallback={<p className="text-text-3 p-6 text-sm">正在打开原书排版…</p>}>
              <FoliateBookView
                ref={foliateRef}
                bookId={bookId}
                format={format}
                startCfi={startCfi}
                startFraction={startCfi ? null : initialProgress}
                layout={layoutMode}
                transition={pageTransition}
                marginX={margin}
                marginY={blockMargin}
                style={foliateStyle}
                annotations={annotations}
                onSelect={onFoliateSelection}
                onAnnotationClick={onFoliateAnnotationClick}
                onAnchor={onFoliateAnchor}
                onImageOpen={openBookImage}
                onLocationChange={(relocate) => {
                  rememberFoliateLocation(relocate);
                  // A page turn moves the words, not the toolbar: re-anchor it.
                  // Only worth measuring while there is one to move.
                  if (toolbarOpen) remeasureSelection();
                }}
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
                surface.mode === "dark" && invertBookImages && "invert-book-images",
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
                        className="focus-visible:focus-ring cursor-pointer underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-70"
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
                            // An annotation-backed run opens the same toolbar
                            // a fresh selection gets, in edit mode. The
                            // wrapper is an anchor, not a `<button>`: buttons
                            // render as inline-block even with
                            // `display: inline`, and one atomic box breaks
                            // the paragraph's justified line breaking. A
                            // native anchor is focusable and Enter-clickable
                            // for free; the inner `<mark>` keeps the
                            // highlight semantics. The ink comes from the
                            // annotation's own colour and style.
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
                              <mark
                                className="text-inherit"
                                style={markInk(
                                  segment.color,
                                  segment.style as AnnotationStyle | null,
                                )}
                              >
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
        {paged && shownPages && (
          <p
            data-page-indicator
            className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 text-xs tabular-nums opacity-70"
            style={{ color: surface.fg }}
          >
            {shownPages.estimated && "约 "}
            {shownPages.page} / {shownPages.pages} 页
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
                "focus-visible:focus-ring glass-solid shadow-panel text-text-2 hover:text-text-1 absolute top-1/2 left-3 z-20",
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
                "focus-visible:focus-ring glass-solid shadow-panel text-text-2 hover:text-text-1 absolute top-1/2 right-3 z-20",
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
          loading={speechLoading}
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
          3s (see the exitHint effect). Non-interactive on purpose. */}
      {fullscreen && (
        <div
          aria-hidden={!exitHint}
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center",
            "transition-all duration-500 ease-out motion-reduce:transition-none",
            exitHint ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
          )}
        >
          <span className="glass-solid shadow-panel text-text-2 rounded-full px-4 py-1.5 text-xs">
            Esc 退出全屏
          </span>
        </div>
      )}

      {/* Selection toolbar (readest-style) or the 词典/翻译 popup — the
          AnimatePresence inside handles the mount/unmount pop. */}
      <SelectionOverlay
        toolbar={
          pending
            ? {
                x: pending.x,
                y: pending.y,
                bottom: pending.bottom,
                annotation: pendingAnnotation,
                defaultColor: settings.highlightColor,
                defaultStyle: settings.highlightStyle,
                onCopy: copySelection,
                onSearch: searchSelection,
                onSpeak: () => {
                  if (!pending) return;
                  speakFromSelection(pending.range);
                  window.getSelection()?.removeAllRanges();
                  setPending(null);
                },
                onAsk: () => {
                  if (!pending) return;
                  askAboutSelection(pending.range);
                },
                onLookup: openLookup,
                onHighlight: (color, style) => {
                  if (!pending) return;
                  createHighlight(pending.range, color, style);
                },
                onRestyle: (color, style) => {
                  if (!pendingAnnotation) return;
                  restyleHighlight(pendingAnnotation.id, color, style);
                },
                onNote: noteOnSelection,
                onDelete: () => {
                  if (!pendingAnnotation) return;
                  deleteAnnotation.mutate(pendingAnnotation.id);
                  setPending(null);
                },
                onClose: () => {
                  window.getSelection()?.removeAllRanges();
                  setPending(null);
                },
              }
            : null
        }
        lookup={lookup}
        onLookupClose={() => setLookup(null)}
      />

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
                        : panel === "guide"
                          ? "AI 导读"
                          : "AI 助手"
            }
            onClose={() => {
              if (panel === "search") {
                setSearch("");
                // Drop the match highlights foliate painted into the pages.
                if (useFoliate) foliateRef.current?.clearSearch();
              }
              setPanel("none");
            }}
          >
            {/* Keyed so a swap rises in. The drawer stays put while its
                content changes, and cutting between panels as different as a
                chapter list and a settings sheet reads as a jump rather than
                a step sideways. `flex min-h-0 flex-1 flex-col` preserves
                every panel's own fill-the-drawer layout — they all root
                the same way. */}
            <Reveal key={panel} className="flex min-h-0 flex-1 flex-col">
              {panel === "toc" && (
                <TocPanel
                  chapters={useFoliateToc ? foliateChapters : chapters}
                  outline={outline}
                  currentIdx={useFoliateToc ? foliateTocIdx : chapterIdx}
                  bookmarks={bookmarks ?? []}
                  busy={createBookmark.isPending || deleteBookmark.isPending}
                  onJump={(idx) => {
                    setPanel("none");
                    if (useFoliateToc) {
                      foliateRef.current?.goToEntry(idx);
                      return;
                    }
                    goTo(idx);
                  }}
                  onJumpBookmark={(bookmark: Bookmark) => {
                    setPanel("none");
                    jumpTo(bookmark.chapterIdx, bookmark.fraction ?? 0);
                  }}
                  onDeleteBookmark={(id) => deleteBookmark.mutate(id)}
                  onAddBookmark={addBookmark}
                />
              )}
              {panel === "settings" && <SettingsPanel />}
              {panel === "annotations" && (
                <AnnotationList
                  annotations={annotations ?? []}
                  busy={deleteAnnotation.isPending || setAnnotationNote.isPending}
                  onDelete={(id) => deleteAnnotation.mutate(id)}
                  onNote={(id, note) => setAnnotationNote.mutate({ id, note })}
                  onExport={() => setExportingNotes(true)}
                  onJump={
                    useFoliate
                      ? (annotation) => {
                          setPanel("none");
                          // A highlight with no anchor still has its text and the
                          // chapter it was recorded in, and those are enough: the
                          // chapter's own start is the landmark foliate can use,
                          // and the view mints the anchor from the text once it
                          // is there. The fraction is how the two numbering
                          // schemes meet (see `rememberFoliateLocation`).
                          foliateRef.current?.goToHighlight({
                            id: annotation.id,
                            cfi: annotation.cfi,
                            text: annotation.text,
                            fraction: globalProgress(chapters, annotation.chapterIdx, 0),
                          });
                        }
                      : undefined
                  }
                />
              )}
              {panel === "search" &&
                (useFoliate ? (
                  <FoliateSearchPanel
                    initialQuery={searchSeed}
                    onSearch={(query) => foliateRef.current?.search(query) ?? Promise.resolve([])}
                    onPick={(cfi) => {
                      setPanel("none");
                      foliateRef.current?.goToCfi(cfi);
                    }}
                  />
                ) : (
                  <SearchPanel
                    bookId={bookId}
                    initialQuery={searchSeed}
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
              {panel === "guide" && <GuidePanel bookId={bookId} />}
            </Reveal>
          </ReaderDrawer>
        )}
      </AnimatePresence>

      {/* Lightbox viewer: blank areas close, Esc closes, arrows flip the book's images. */}
      <OverlayPortal>
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
      </OverlayPortal>

      {/* Exporting happens over the book, not instead of it: the drawer stays
          where it was, and closing the dialog puts the reader back on the list
          they were reading from. */}
      {exportingNotes && bookId && (
        <Suspense fallback={null}>
          <ExportNotesDialog
            subject={`《${title}》`}
            name={title}
            highlights={(annotations ?? []).length}
            notes={(annotations ?? []).filter((annotation) => annotation.note !== null).length}
            busy={exportNotes.isPending}
            error={exportNotes.error ? String(exportNotes.error) : null}
            onCancel={() => {
              setExportingNotes(false);
              exportNotes.reset();
            }}
            onConfirm={(path) =>
              exportNotes.mutate(
                { id: bookId, path },
                { onSuccess: () => setExportingNotes(false) },
              )
            }
          />
        </Suspense>
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
  // A `colorreader://` link lands here as a plain query parameter, so the deep
  // link and a search result reach the reader the same way.
  const initialAnnotation = searchParams.get("annotation");

  const book = useBook(bookId);
  const toc = useReaderToc(bookId);
  // Only when a link named a highlight: the row carries the position, and the
  // reader has to be arranged around it *before* it mounts. Resolving it later
  // would mean opening the book in the wrong place and then jumping — a scroll
  // the reader would see. `null` leaves the query idle, so an ordinary open
  // pays for nothing.
  const linkedAnnotations = useAnnotations(initialAnnotation === null ? null : bookId);

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
    if (initialAnnotation !== null && linkedAnnotations.isPending) {
      return <p className="text-text-3 text-sm">正在定位这条标注…</p>;
    }
    return null;
  }, [
    bookId,
    book.isPending,
    book.isError,
    toc.isPending,
    toc.isError,
    navigate,
    initialAnnotation,
    linkedAnnotations.isPending,
  ]);

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
      initialProgress={bookSummary.progress ?? 0}
      initialCfi={bookSummary.location}
      initialChapter={initialChapter}
      initialQuery={initialQuery}
      initialOffset={initialOffset}
      initialAnnotation={initialAnnotation}
      onBack={() => navigate("/")}
    />
  );
}
