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
import { BookOpen, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { AnimatePresence, useReducedMotion } from "motion/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { isFoliateFormat } from "@/features/library/format";
import { useAssetUrl } from "@/features/reader/assets";
import {
  IMAGE_PARAGRAPH_PREFIX,
  LINK_PARAGRAPH_PREFIX,
  WALLPAPER_PARAGRAPH_PREFIX,
  isProseParagraph,
  parseLinkParagraph,
} from "@/features/reader/chapterText";
import { usePdfZoom } from "@/features/reader/usePdfZoom";
import { useFoliateStyle } from "@/features/reader/useFoliateStyle";
import { useReaderFullscreen } from "@/features/reader/useReaderFullscreen";
import { FULLSCREEN_MARGIN_BONUS, useReaderLayout } from "@/features/reader/useReaderLayout";
import { applyPosition, columnPitch, flipPage } from "@/features/reader/paging";
import { snapshotPdfTurn } from "@/features/reader/pdfTurn";
import type { CurlTurn } from "@/features/reader/pdfCurl";
import { ImageLightbox } from "@/features/reader/ImageLightbox";
import { ReaderFooterControls, ReaderHeaderBar } from "@/features/reader/ReaderChrome";
import { ReaderPanels } from "@/features/reader/ReaderPanels";
import { ReaderChapterView } from "@/features/reader/ReaderChapterView";
import { PullBookmark } from "@/features/reader/PullBookmark";
import { ReadingRuler, rulerStepForKey } from "@/features/reader/ReadingRuler";
import type { ReadingRulerHandle } from "@/features/reader/ReadingRuler";
import { relayRulerLayout, relayRulerTurn } from "@/features/reader/rulerPointer";
import { medianCpm } from "@/features/reader/pace";
import {
  globalProgress,
  locateChapter,
  remainingChars,
  totalChars,
} from "@/features/reader/progress";
import {
  highlightSegments,
  inkWash,
  paragraphAt,
  resolveSelection,
  selectionBottom,
  type TextRange,
} from "@/features/reader/selection";
import { RsvpPlayer } from "@/features/reader/RsvpPlayer";
import { SelectionOverlay, type LookupKind } from "@/features/reader/SelectionToolbar";
import type { AnnotationStyle } from "@/types/ipc";
import { useTts } from "@/features/reader/tts";
import { TtsPlayer } from "@/features/reader/TtsPlayer";
import { resolveFont, resolveSurface, readerGlassVars } from "@/features/reader/theme";
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
import { useGamepadPager } from "@/hooks/useGamepadPager";
import {
  useBook,
  useBookImages,
  useChapter,
  usePdfOutline,
  useReaderToc,
  useSetProgress,
} from "@/hooks/useReader";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useImageLightbox } from "@/hooks/useImageLightbox";
import { useHitJumps } from "@/hooks/useHitJumps";
import { usePageCounter } from "@/hooks/usePageCounter";
import { useReadAloud } from "@/hooks/useReadAloud";
import { useReadingClock, useReadingPace } from "@/hooks/useReading";
import { useReaderPanels } from "@/hooks/useReaderPanels";
import { useSleepTimer } from "@/hooks/useSleepTimer";
import {
  LINE_HEIGHTS,
  PARA_GAPS,
  useReaderSettings,
  pageIsNight,
  HIGHLIGHT_COLORS,
} from "@/stores/reader";
import { boxOf, useBookHandoff } from "@/stores/book-handoff";
import { useChrome } from "@/stores/chrome";
import { cn } from "@/lib/cn";
import type { PdfOutlineItem } from "@/lib/pdf";
import type { Annotation, BookFormat, Bookmark, ChapterMeta, LocalFont } from "@/types/ipc";

/** Notes export reaches for the native save dialog; kept out of the reader's
 *  own chunk so the reader still loads without it. */
const ExportNotesDialog = lazy(() =>
  import("@/features/reader/ExportNotesDialog").then((module) => ({
    default: module.ExportNotesDialog,
  })),
);

/** How long to wait after scrolling stops before persisting the position. */
const SAVE_DELAY_MS = 600;

/**
 * How long the page has to stand still before the reading ruler re-measures.
 *
 * Longer than the longest page-turn animation (450 ms, `flipPage`'s slide):
 * that animation is a *transform* on the scroller, and the lines' measured
 * positions include it, so a measure taken while one is running reads a page in
 * flight and parks the band on whatever block a half-slid page put under it.
 * The animation starts after the jump's own scroll event, so the settle has to
 * outlast it rather than the event.
 */
const RULER_SETTLE_MS = 520;

/** Gutter between the two columns of a spread: the page margin itself, so the
 * centre gap matches the outer margins and both paged modes share one rhythm. */

/** Wheel silence (ms) that ends one trackpad gesture and re-arms paging. */
const GESTURE_GAP = 200;

/** Wheel travel that starts a turn. Below this a nudge is not a gesture. */
const WHEEL_START_PX = 48;

/**
 * How far a dragged sheet has to travel before letting go turns the page.
 * Low, because a trackpad's own inertia carries a flick well past halfway on
 * its own — waiting for half would make a normal swipe spring back.
 */
const SCRUB_COMMIT = 0.35;

/**
 * Stand-in for the book's image list while the query is in flight. A fresh
 * `[]` per render would re-create every callback that reads it.
 */

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

/** Which side panel is open. Only one at a time, so they never stack. */
/** Which side panel is open lives with the panels themselves: see
 *  `useReaderPanels`, and `ReaderChrome` for the union. */

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
  /** What the 返回 button says; where it goes is `onBack`'s business. */
  backLabel: string;
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
  backLabel,
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
    rsvpWpm,
    paceSamples,
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
  // counts the whole book (the tally below, or foliate's own counter). One flag
  // for the two on-modes: the measurement below is what both of them need.
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
  // The engine binding stays here rather than moving into `useReadAloud`: `goTo`
  // stops the voice on every chapter change, so `stop` has to exist before the
  // read-aloud layer can be built. The hook is handed the binding instead — see
  // it for why the dependency cannot run the other way.
  const tts = useTts({ trackBoundary: speechGranularity === "word" });
  const stop = tts.stop;

  /** The sleep timer and the two ways it changes. It is handed the voice's
   *  `stop` because stopping is its job and the voice is not its business. */
  const { sleep, choose: chooseSleep, clearIfChapterEnded } = useSleepTimer(stop);

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
  // Formats whose chapters *are* their pages, one rendered unit apiece: a comic
  // archive is one plate per entry, a PDF one canvas per page. Their page
  // counts are already exact, so the indicator reads them off the chapter list
  // instead of estimating a book from a single page of it — which is where
  // "1 / 1 页" on every page of a PDF came from.
  const chapterIsPage = isPdf || format === "cbz";
  // Two renderers, one corpus. foliate keeps a book's own XHTML + CSS: for
  // MOBI and AZW3 that is the only faithful rendering (wallpapers, part-title
  // plates, inline art) and an EPUB asks for no less — so all three go through
  // it, off the one list the notes page reads too (`isFoliateFormat`).
  // Everything else renders the extracted text: FB2 / CBZ / TXT / MD gain
  // nothing the text model cannot already do, and PDF renders through its own
  // pdf.js pipeline (foliate's PDF path is stubbed out). The chapters in the
  // database are the same either way, so search, TTS and AI never care which
  // renderer is on screen.
  const useFoliate = isFoliateFormat(format);
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
  /** The reader's position in whole-book pages, as foliate numbers them: the
   *  book's own byte domain, fixed for the book, so it does not move with the
   *  section on screen. `null` until foliate has built its table — the
   *  indicator falls back to the section's own counter until then. */
  const [foliateBookPage, setFoliateBookPage] = useState<{
    page: number;
    pages: number;
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
      setFoliateBookPage(location.bookPage);
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
  /**
   * Whether the next page lies to the left.
   *
   * A vertical column is read top-to-bottom and the columns run right-to-left,
   * so the page after this one is the column on its *left*: the arrow keys
   * have to point at where the next page comes from, not at a fixed side.
   * foliate reads the axis the same way — a `vertical-rl` section turns pages
   * on the horizontal-rtl convention — and only a foliate book can be vertical
   * at all. A right-to-left horizontal book belongs here too; that would need
   * the book's own `dir` plumbed out of the renderer.
   */
  const readsLeftward = useFoliate && settings.vertical;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The reading viewport: the box the reading ruler is positioned against,
  // which is the pane below the header rather than the window.
  const viewportRef = useRef<HTMLDivElement>(null);
  // The foliate view, driven imperatively (see flip /
  // stepChapter): paging and sections never touch our chapter index.
  const foliateRef = useRef<FoliateHandle | null>(null);
  /** Drops the match highlights foliate painted into the pages. Stable,
   *  because the panels hook keeps `close` identity-stable for the key
   *  handler's dependency list. */
  const clearPaintedMatches = useCallback(() => {
    if (useFoliate) foliateRef.current?.clearSearch();
  }, [useFoliate]);
  /**
   * Which panel is open, and the search drawer's query.
   *
   * It is declared down here rather than up with the rest of the reader's
   * state because closing the drawer has to reach the foliate view above it —
   * the query is not the only thing the search leaves behind. See
   * `useReaderPanels`.
   */
  const {
    panel,
    setPanel,
    toggle: togglePanel,
    search,
    setSearch,
    close: closePanel,
  } = useReaderPanels(initialQuery, clearPaintedMatches);
  // The reading ruler's lines, asked of the book rather than read from here:
  // a foliate book's words are in section iframes, and only the view knows
  // where those sections currently sit. Stable, because the ruler measures on
  // it and an unstable prop would re-measure on every render.
  const foliateRulerLines = useCallback(() => foliateRef.current?.rulerLines() ?? null, []);
  // The reading ruler, driven imperatively for the same reason the foliate view
  // is: an arrow key has to ask the band to step *before* it becomes a page turn,
  // and only the ruler knows whether there is another block of lines to step to.
  const rulerRef = useRef<ReadingRulerHandle | null>(null);

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
  /**
   * The write half of the slot above, handed to the hit jumps rather than the
   * ref itself: a hook must not mutate a value it does not own, and this one
   * is read by `applyPending` — in the navigation, declared further down.
   */
  const setPendingFocus = useCallback((offset: number | null) => {
    pendingFocus.current = offset;
  }, []);
  const debounceRef = useRef<number | null>(null);
  // Pending "the page has stopped moving" notice to the reading ruler. Its own
  // timer, not `debounceRef`: that one persists the position and the two must be
  // able to disagree about when the page settled.
  const rulerSettleRef = useRef<number | null>(null);
  // The way the page last turned, for the same notice: a page the reader arrived
  // on meets the band at its start, and one page turn can still be settling when
  // the notice goes out, so the direction has to outlive the call to `flip`.
  const rulerDirRef = useRef<1 | -1 | 0>(0);
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
      // The PDF's text layer arrives with the pages, not with the chapter: tell
      // the ruler the geometry changed, or its first placement measures whatever
      // fragments happened to be painted when it asked.
      relayRulerLayout(viewportRef.current);
    },
    [layoutModeRef, marginRef],
  );
  /** Folds each progress save into the reading-speed estimate. The hook owns
   *  the two refs that used to sit here — see `useReadingPace`. */
  const reportPace = useReadingPace();
  /** Hover-reveal flip affordance for paged modes; hides itself after 2s idle. */
  const [flipHint, setFlipHint] = useState(false);
  /** 1-based position inside the chapter's column count, for the page indicator. */
  const [pageInfo, setPageInfo] = useState<{ page: number; pages: number } | null>(null);

  /**
   * Every setting a page count depends on. A change re-paginates the chapter,
   * so the pages already in the tally belong to a layout that is gone.
   */
  const densityKey = `${layoutMode}|${marginX}|${marginY}|${fullscreen}|${fontSize}|${lineHeightIdx}|${paraGapIdx}|${indent}`;

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
  /**
   * The page indicator, and the tally its whole-book unit is built from.
   *
   * `densityKey` comes in as the one value it is: which settings a page count
   * depends on is a layout fact, and the string is what the tally is
   * invalidated against.
   */
  const pageCounter = usePageCounter({
    unit: pageNumbers,
    chapterIsPage,
    useFoliate,
    chapters,
    chapterIdx,
    fraction,
    pageInfo,
    foliatePage,
    foliateBookPage,
    densityKey,
    // The test the tally has always made, kept literal on purpose — see the
    // option's own note on why it is not `!chapterData`.
    chapterMissing: chapterData === null,
  });
  // Aliased so the scroll handler and the indicator keep reading the same two
  // names: `countChapterPages` goes into that handler's dependency list, so it
  // has to be a plain identifier there.
  const { shown: shownPages, count: countChapterPages } = pageCounter;
  const bookImagesQuery = useBookImages(bookId);
  /**
   * The book's pictures, and which one the lightbox viewer is on.
   *
   * The importer's list wins whenever it has one; the browser build has no
   * `book_images`/`book_asset` behind it, so pictures arrive already decoded by
   * foliate and each click registers its entry path, the blob URL foliate made
   * and the section it lives in.
   *
   * Aliased to the names the four call sites already used — the keyboard
   * handler, the chapter view, foliate's click, and the viewer itself.
   */
  const {
    images: bookImages,
    urls,
    path: lightboxPath,
    index: lightboxIdx,
    openAt: openImageAt,
    openFromBook: openBookImage,
    step: stepLightbox,
    close: closeLightbox,
  } = useImageLightbox(bookImagesQuery.data);

  const fontsQuery = useFonts();
  const fonts = fontsQuery.data ?? NO_FONTS;

  // Set when the voice rolls off the end of a chapter, consumed by the
  // position effect below once the next chapter has rendered.
  const autoAdvance = useRef(false);

  /**
   * Auto-scroll. Declared here rather than beside the other reading settings
   * because `goTo` below clears it on a chapter jump, and the loop needs the
   * layout refs this far down.
   *
   * Destructured to the names the two call sites already used: the footer's
   * props are unchanged, and `stopAutoScroll` is a plain identifier for
   * `goTo`'s dependency list.
   */
  const {
    on: autoScrollOn,
    toggle: toggleAutoScroll,
    stop: stopAutoScroll,
  } = useAutoScroll({
    paged,
    speed: autoScrollSpeed,
    useFoliate,
    layoutModeRef,
    foliateRef,
    scrollRef,
  });

  /**
   * The page the reader is on, read by `goTo` rather than the page number it
   * closes over. A held turn reverts through a `goTo` built *before* the turn
   * moved the page, and one reading its own captured number answers "already
   * there" to the very page it is being asked to go back to.
   */
  const chapterIdxRef = useRef(chapterIdx);
  useEffect(() => {
    chapterIdxRef.current = chapterIdx;
  }, [chapterIdx]);

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
        stopAutoScroll();
        foliateRef.current?.goToFraction(at);
        return;
      }
      if (clamped === chapterIdxRef.current) return;
      // A chapter switch invalidates the paragraph queue the voice is walking.
      stop();
      setNav(clamped > chapterIdxRef.current ? 1 : -1);
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
      stopAutoScroll();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [chapterIdxRef, chapters, isPdf, layoutModeRef, setProgress, stop, stopAutoScroll, useFoliate],
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
    if (clearIfChapterEnded()) {
      stop();
      return;
    }
    if (chapterIdx < chapters.length - 1) {
      autoAdvance.current = true;
      goTo(chapterIdx + 1);
    }
  }, [chapterIdx, chapters.length, goTo, stop, clearIfChapterEnded]);

  /**
   * Read-aloud, over whichever queue the renderer on screen provides.
   *
   * `paragraphs` is the chapter's prose with the wallpaper markers already
   * blanked — the same list the queue is cut from, so a marker never becomes an
   * utterance. `onChapterEnd` is the voice rolling past the last unit of a
   * chapter, which is navigation's business (the same shape as the sleep
   * timer's `onFire`).
   */
  const readAloud = useReadAloud({
    tts,
    useFoliate,
    isPdf,
    paragraphs: chapterData?.paragraphs ?? null,
    scrollRef,
    foliateRef,
    storedVoice: speechVoiceURI,
    rate: speechRate,
    granularity: speechGranularity,
    updateSettings: settings.update,
    onChapterEnd,
  });
  // Destructured for the dependency arrays below: a member expression there is
  // not statically checkable, and depending on `readAloud` itself would rebuild
  // them on every render — which for the position effect means re-applying the
  // pending scroll, i.e. snapping the page back to the top of the chapter.
  const { span: speechSpan, playFromStart } = readAloud;

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
      if (continueSpeech) playFromStart();
      if (focus !== null) {
        const target = paragraphAt(paragraphs, focus);
        el.querySelector(`[data-para-idx="${target}"]`)?.scrollIntoView({ block: "center" });
        return;
      }
      if (isPdf && layoutModeRef.current === "scroll") {
        // A PDF's scroll layout is a stack of uniform page slots, and the saved
        // position is a *page index*: the chapter fraction inside a page is
        // always zero, so the fraction that lands on the page is the page's own
        // share of the book. Without this the book reopens at its first page.
        if (pdfSlotH.current > 0) {
          el.scrollTop = chapterIdx * pdfSlotH.current;
          return;
        }
        applyPosition(el, globalProgress(chapters, chapterIdx, 0), "scroll", marginRef.current);
        return;
      }
      applyPosition(el, frac, layoutModeRef.current, marginRef.current);
    },
    [
      chapterData,
      chapterIdx,
      chapters,
      isPdf,
      layoutModeRef,
      marginRef,
      // `playFromStart` carries the queue and `onChapterEnd` in its own
      // identity, so neither is listed again here.
      playFromStart,
    ],
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
      // New chapter, new lines: the ruler measures the page it is now over. The
      // chapter body is in the DOM by the time this effect runs, and the frame
      // covers the tail spacer the ruler's own geometry depends on. A turn's
      // direction rides along once — a page the reader arrived on meets the band
      // at its start — and is spent here, so a later chapter jump (a bookmark, a
      // TTS roll) keeps the band where the reader was put.
      const dir = rulerDirRef.current;
      rulerDirRef.current = 0;
      relayRulerLayout(el, dir);
    });
    return () => cancelAnimationFrame(frame);
  }, [chapterData, applyPending, measureTail]);

  /** Flips one page in a paged layout; rolls into the neighbouring chapter at the edges. */
  /**
   * One page turn. `scrub` asks for the turn to be left open so a gesture can
   * drive it — the handle comes back instead of the animation being started —
   * and is only honoured where there is a sheet to hold (a paged PDF turning
   * with the mesh curl). Everywhere else the turn plays out on its own.
   */
  const flip = useCallback(
    (dir: 1 | -1, scrub = false): CurlTurn | null => {
      if (useFoliate) {
        // At the first/last page of the current section, roll explicitly into
        // the neighbouring section (foliate's implicit next()/prev() cross only
        // when its scroll probe reports the page edge, which is fragile);
        // otherwise turn the page normally. This makes "last page + next ->
        // next chapter" deterministic for keyboard paging.
        const handle = foliateRef.current;
        if (!handle) return null;
        // Same handover as the prose turn below: out of the way while the page
        // moves, back on the page that arrives (foliate relays that itself, with
        // the direction it was flipped).
        relayRulerTurn(viewportRef.current, dir);
        if (handle.atEdge(dir)) handle.section(dir);
        else handle.flip(dir);
        return null;
      }
      const el = scrollRef.current;
      if (!el) return null;
      // A prose page turn is a page the reader arrives on: the ruler is told the
      // turn has started — it steps out of the way rather than riding this page
      // down to its last line — and meets the new page at the far edge when the
      // turn's own relay lands (see `flipPage` / the settle notice in `onScroll`).
      rulerDirRef.current = dir;
      relayRulerTurn(el, dir);
      if (isPdf) {
        // A PDF page fills the viewport exactly — there is no column to
        // slide, so a flip is a page step (two at a time in the spread).
        //
        // The page being left has to be copied out before the step: it lives
        // in the canvas pdf.js is about to redraw, so once the number changes
        // there is nothing left to animate. The copy rides over the incoming
        // page until the turn is done (see `pdfTurn.ts`). Scroll layout skips
        // it — there the step is a scroll through a continuous strip.
        const step = layoutModeRef.current === "double" ? 2 : 1;
        const turn =
          layoutModeRef.current !== "scroll"
            ? snapshotPdfTurn(viewportRef.current, dir, pageTransition, reduce)
            : null;
        goTo(chapterIdx + dir * step);
        if (!turn) return null;
        // Held open for a gesture. Letting go without committing puts the page
        // back: `chapterIdx` is where this turn started, and the revert runs
        // while the sheet still covers the page, so the reader never watches it
        // re-render.
        if (!scrub) {
          turn.finish(true);
          return null;
        }
        return {
          set: turn.set,
          finish: (commit: boolean) => turn.finish(commit, () => goTo(chapterIdx)),
        };
      }
      const max = el.scrollWidth - el.clientWidth;
      const pos = el.scrollLeft;
      if (dir === 1 && pos >= max - 2) {
        goTo(chapterIdx + 1);
        return null;
      }
      if (dir === -1 && pos <= 2) {
        goTo(chapterIdx - 1);
        return null;
      }
      // Snap to an exact column boundary: the viewport width includes the page
      // margins, so scrolling by clientWidth drifts and slices the next column.
      const mode = layoutModeRef.current;
      const margin = marginRef.current;
      const pitch = columnPitch(el, mode, margin);
      const page = pitch > 0 ? (mode === "double" ? 2 : 1) : 0;
      if (page === 0 || pitch <= 0) {
        flipPage(el, pos + dir * el.clientWidth, pageTransition, dir, reduce);
        return null;
      }
      const target = (Math.round(pos / pitch) + dir * page) * pitch;
      flipPage(el, Math.max(0, Math.min(target, max)), pageTransition, dir, reduce);
      return null;
    },
    [chapterIdx, goTo, isPdf, layoutModeRef, marginRef, useFoliate, pageTransition, reduce],
  );

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

  /**
   * The wheel gesture, held across rebuilds of the handler below.
   *
   * A drag starts a turn, and starting a turn changes the page number — which
   * rebuilds `flip`, which re-runs the effect. Anything the handler kept in its
   * own locals would be dropped on the very event that began the gesture: the
   * accumulator would start over and the sheet would be lost with the page
   * already turned, with nothing left holding it.
   */
  const dragState = useRef({
    acc: 0,
    at: 0,
    flipped: false,
    progress: 0,
    timer: 0,
    drag: null as CurlTurn | null,
  });

  // In paged modes the wheel flips whole pages instead of nudging pixels:
  // free pixel scrolling always ends between two columns. A zoomed PDF pans
  // natively instead, and a pinch scales rather than flips.
  useEffect(() => {
    if (layoutMode === "scroll") return;
    if (isPdf && pdfZoom !== 1) return;
    const el = scrollRef.current;
    if (!el) return;
    const state = dragState.current;

    /**
     * How far the wheel has dragged the sheet. Measured from where the turn was
     * claimed, not from zero: the travel that earned the turn is spent, and
     * counting it again would jump the sheet the moment it appears.
     */
    const travelled = (acc: number, width: number) =>
      Math.min(1, Math.max(0, (Math.abs(acc) - WHEEL_START_PX) / Math.max(1, width)));

    /** The gesture is over: let the sheet go, one way or the other. */
    const settle = () => {
      window.clearTimeout(state.timer);
      state.timer = 0;
      state.acc = 0;
      state.flipped = false;
      const held = state.drag;
      state.drag = null;
      if (!held) return;
      held.finish(state.progress > SCRUB_COMMIT);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const now = performance.now();
      // One gesture = one page. Trackpad inertia keeps firing events long
      // after the flip, so a fixed cooldown would turn one swipe into two
      // pages; instead, only silence longer than GESTURE_GAP re-arms flipping.
      if (now - state.at > GESTURE_GAP) settle();
      state.at = now;
      state.acc += event.deltaY + event.deltaX;
      if (state.drag) {
        state.progress = travelled(state.acc, el.clientWidth);
        state.drag.set(state.progress);
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(settle, GESTURE_GAP);
        return;
      }
      if (state.flipped) return;
      if (Math.abs(state.acc) >= WHEEL_START_PX) {
        // A turn that can be held — a paged PDF turning with the mesh curl —
        // is handed over to the wheel from here, and the sheet follows the
        // gesture instead of stepping a whole page at once.
        const held = flip(state.acc > 0 ? 1 : -1, true);
        if (!held) {
          state.acc = 0;
          state.flipped = true;
          return;
        }
        state.drag = held;
        // Where this event already dragged it — a fast swipe arrives as one
        // large delta, and the sheet has to answer it on the spot rather than
        // waiting for a second event that may never come.
        state.progress = travelled(state.acc, el.clientWidth);
        held.set(state.progress);
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(settle, GESTURE_GAP);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // The drag is deliberately not settled on teardown: starting one changes
    // the page number, which rebuilds `flip` and re-runs this effect, and
    // settling there would commit a page the reader still has hold of. The
    // overlay lives inside the viewport, so an unmount takes it with it.
    return () => el.removeEventListener("wheel", onWheel);
  }, [flip, isPdf, layoutMode, pdfZoom]);

  // Keyboard paging.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (lightboxPath !== null) {
        if (event.key === "Escape") {
          closeLightbox();
        } else if (event.key === "ArrowRight") {
          stepLightbox(1);
        } else if (event.key === "ArrowLeft") {
          stepLightbox(-1);
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
        // The drawer's own way out, cleanup and all. This used to be written
        // out here — clear the query, set the panel to none — and it forgot
        // the other half of what the search drawer leaves behind, so Escape
        // closed it and left foliate's match highlights painted on the page.
        if (closePanel()) return;
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
      // The reading ruler owns the arrows while it is on, because that is what
      // reading with it means: each press lays the band over the next block of
      // lines, and the band arrives where the press put it — no second
      // adjustment. Only when the page runs out does the key move the reading
      // instead: a page turn in the paged layouts, one step of scroll in the
      // scroll layout, which brings the next block under the band where it is.
      //
      // Horizontal type reads down the page, so all four arrows step it. Vertical
      // type reads leftward, where Left/Right are the page turns, so only Up/Down
      // step the band (the reference's own rule).
      if (settings.readingRuler) {
        // Left/Right are spoken for: by the page turns in vertical type, and by
        // the chapter steps of the scroll layout. Up/Down step the band in both.
        const step = rulerStepForKey(event.key, readsLeftward || !paged);
        if (step !== 0) {
          if (!(rulerRef.current?.move(step) ?? false)) {
            const el = scrollRef.current;
            if (paged) flip(step);
            else if (el) {
              // One step of the reader's own leading, times the lines the band
              // spans: the same distance the band walks inside a page.
              el.scrollBy({
                top: step * fontSize * (LINE_HEIGHTS[lineHeightIdx] ?? 1.8) * settings.rulerLines,
                behavior: "smooth",
              });
            }
          }
          event.preventDefault();
          return;
        }
      }
      // Page-turner keys. A pedal that presents as a keyboard sends one of
      // these: PageUp/PageDown on the ones that mimic a document reader, Space
      // on the ones that mimic a clicker, and the media keys on the ones that
      // mimic a remote. Space and the media keys are claimed here because in a
      // paged layout they do nothing otherwise — in the scroll layout the
      // browser's own Space and PageDown are the right answer and are left
      // alone.
      if (paged) {
        const dir =
          event.key === "PageDown" || event.key === "MediaTrackNext"
            ? 1
            : event.key === "PageUp" || event.key === "MediaTrackPrevious"
              ? -1
              : 0;
        if (dir !== 0) {
          flip(dir);
          event.preventDefault();
          return;
        }
        if (event.key === " " && !event.shiftKey) {
          flip(1);
          event.preventDefault();
          return;
        }
      }
      if (paged && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        const ahead = event.key === (readsLeftward ? "ArrowLeft" : "ArrowRight");
        flip(ahead ? 1 : -1);
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
    // The ruler's scroll-layout step is one block of the reader's own leading.
    fontSize,
    flip,
    fullscreen,
    lineHeightIdx,
    lightboxPath,
    lookup,
    closeLightbox,
    // Not `panel`: the handler asks `closePanel()` whether it consumed the
    // key, and that callback keeps one identity across renders — so this
    // listener no longer re-binds every time a drawer opens or closes.
    closePanel,
    paged,
    pending,
    readsLeftward,
    // The ruler claims the arrows only while it is on, so the handler has to
    // re-bind when it is switched on — otherwise the key that just turned the
    // band on would keep turning pages until something else changed.
    settings.readingRuler,
    settings.rulerLines,
    stepChapter,
    stepLightbox,
    toggleFullscreen,
  ]);

  // One step of the page, whichever way this layout moves: a page turn in the
  // paged layouts, a chapter in the scrolled one — the same split the arrow
  // keys already make, shared with the gamepad pedal.
  const pageStep = useCallback(
    (dir: 1 | -1) => {
      if (paged) flip(dir);
      else stepChapter(dir);
    },
    [flip, paged, stepChapter],
  );

  // A gamepad or a Bluetooth page-turner: the same two actions the arrows
  // own, driven from a pedal. Always on — a pad attached to a reading app is
  // there to turn pages, and there is nothing else here it could mean.
  useGamepadPager({
    enabled: true,
    onNext: () => pageStep(1),
    onPrev: () => pageStep(-1),
  });

  const saveProgress = useCallback(
    (frac: number) => {
      const progress = globalProgress(chapters, chapterIdx, frac);
      setProgress({ progress });
      // Every save marks the end of one reading session: fold it into the
      // sustained speed estimate that powers the remaining-time labels.
      reportPace(progress * totalChars(chapters));
    },
    [chapters, chapterIdx, setProgress, reportPace],
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
        // The same measurement feeds the whole-book estimate: this is a page
        // count the layout actually took, for this chapter's share of the book.
        countChapterPages(pages);
      }
    }
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => saveProgress(frac), SAVE_DELAY_MS);
    // The page has moved under the reading ruler, and it re-measures once the
    // movement is over rather than at the start of it: every way a page turns
    // here ends as a scroll — the instant jump, 「平移」's smooth scroll, and the
    // ones that jump and then animate — but only the last scroll event says the
    // page has arrived. The band stays where it is and is re-derived from the
    // lines now under it, which is the whole idea of it.
    if (rulerSettleRef.current !== null) window.clearTimeout(rulerSettleRef.current);
    rulerSettleRef.current = window.setTimeout(() => {
      // A turn's direction rides along once, then is spent: whatever the next
      // notice is, it is not the same page turn.
      const dir = rulerDirRef.current;
      rulerDirRef.current = 0;
      relayRulerLayout(el, pagedNow ? dir : 0);
    }, RULER_SETTLE_MS);
  }, [
    chapters,
    chapterIdx,
    countChapterPages,
    isPdf,
    layoutModeRef,
    marginRef,
    saveProgress,
    showPages,
  ]);

  // Recompute the page indicator when the setting or layout flips without a
  // scroll event; chapter switches and resizes re-report through `onScroll`.
  // `countChapterPages` changes with the layout and the typography, so this
  // re-measures after those too — the pages it counts are the reader's share
  // of the book, and a stale count is a wrong book length.
  //
  // `chapterData` is what actually re-paginates: a chapter switch lands on an
  // empty scroller while `useChapter` is still fetching, so the measurement
  // taken then is the chapter that just left. `tail` is the second half of the
  // same problem — the end-of-chapter spacer is measured off the chapter that
  // filled the scroller before this one, and until it is re-measured the
  // scroller is still as wide as that chapter, so the count read off it is
  // that chapter's again.
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
    if (pitch <= 0) return;
    // The chapter ends where its spacer puts the end, or at the scroller's own
    // width when there is no spacer to ask. Reading the spacer is also what
    // keeps this measuring again once it has been re-measured for this
    // chapter — an unbuilt spacer leaves the scroller as wide as the chapter
    // that filled it before.
    const contentEnd = tail === null ? el.scrollWidth : tail.left;
    const pages = Math.round((contentEnd - el.clientWidth) / pitch) + 1;
    // Nothing to say about a chapter that is not on screen yet: the number
    // would be the page count of whatever is, wearing this chapter's name.
    if (chapterData === null) return;
    setPageInfo({ page: Math.round(el.scrollLeft / pitch) + 1, pages });
    countChapterPages(pages);
  }, [
    chapterData,
    countChapterPages,
    fullscreen,
    tail,
    useFoliate,
    layoutMode,
    marginX,
    paged,
    showPages,
  ]);

  // Flush a pending save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (foliateSaveRef.current !== null) window.clearTimeout(foliateSaveRef.current);
      if (rulerSettleRef.current !== null) window.clearTimeout(rulerSettleRef.current);
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

  /**
   * Landing the reader on a position named by a search hit or an AI citation:
   * here, after the chapter it names lands, or in another book.
   *
   * Aliased to the two names the panels already hand it over as.
   */
  const { pick: pickHit, follow: jumpToCitation } = useHitJumps({
    bookId,
    chapterIdx,
    paragraphs: chapterData?.paragraphs,
    goTo,
    setPendingFocus,
    scrollRef,
  });

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
  // The paper colour the foliate turn's View Transition snapshots are backed
  // with. It has to sit on the document root, not on the pane: `::view-transition`
  // hangs off `html` and inherits from there, so a var on a descendant never
  // reaches it — and only the night palette gives a section its own background
  // to snapshot, which is why a light surface used to flash white (globals.css
  // `--foliate-vt-bg`). `tint` rather than `background`: the latter may be a
  // gradient or a photo, and this is a colour slot.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--reader-page", surface.tint);
    return () => {
      root.style.removeProperty("--reader-page");
    };
  }, [surface.tint]);
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
  const foliateStyle = useFoliateStyle({
    fontSize,
    font: settings.fontFamily,
    lineHeightIdx,
    paraGapIdx,
    indent,
    surface,
    invertImages: invertBookImages,
    fonts,
    vertical: settings.vertical,
  });
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
  // Nothing to weigh: a PDF whose text is still owed, or whose extraction never
  // landed. Both estimates would answer "不到 1 分钟" for a 400-page book — a
  // wrong number dressed as a precise one — so report the speed as unknown
  // instead, which is what `estimateLabel` makes of it.
  // The remaining-time labels: the median stretch once there are enough of
  // them to take one, the running average until then. The median is the honest
  // one — an average still carries the ten minutes the app sat open on a page.
  const weighedSpeed = totalChars(chapters) > 0 ? (medianCpm(paceSamples) ?? readingSpeed) : 0;

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
      : pageTransition === "paper" || pageTransition === "flip"
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

  const headerBar = (
    <ReaderHeaderBar
      fullscreen={fullscreen}
      onBack={leaveReader}
      backLabel={backLabel}
      bookId={bookId}
      coverUrl={coverUrl}
      coverBoxRef={coverBoxRef}
      title={title}
      index={headerIndex}
      total={headerTotal}
      isPdf={isPdf}
      chapterLabel={headerChapter}
      onTogglePanel={togglePanel}
      pdfZoom={pdfZoom}
      onZoom={(next) => stepPdfZoom(next / pdfZoom)}
      fontSize={fontSize}
      onFontSize={setFontSize}
      atBookmark={atBookmark}
      onToggleBookmark={addBookmark}
      bookmarkPending={createBookmark.isPending || deleteBookmark.isPending}
      onToggleFullscreen={() => void toggleFullscreen()}
      rulerOn={settings.readingRuler}
      onToggleRuler={() => settings.update({ readingRuler: !settings.readingRuler })}
    />
  );

  const footerInner = (
    <ReaderFooterControls
      speechStatus={readAloud.status}
      onToggleSpeech={readAloud.toggle}
      onTogglePlayer={() => readAloud.setPlayerOpen((open) => !open)}
      speechRate={speechRate}
      paged={paged}
      autoScrolling={autoScrollOn}
      onToggleAutoScroll={toggleAutoScroll}
      onStepChapter={stepChapter}
      chapterIdx={chapterIdx}
      total={total}
      chapterRemaining={chapterRemaining}
      bookRemaining={bookRemaining}
      readingSpeed={weighedSpeed}
      progress={displayProgress}
      rsvpOn={readAloud.rsvpOpen}
      onRsvp={readAloud.toggleRsvp}
    />
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
        ref={viewportRef}
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
            // The prose path pins its `<article>`; foliate and PDF have no
            // article, so the host itself is what has to hold its width while
            // the sidebar spring runs.
            //
            // foliate re-paginates the whole book whenever its element is
            // resized, and a per-frame re-pagination of a whole book is what
            // made collapsing or hiding the sidebar janky — the pin turns ~30
            // re-paginations into one, after the spring settles. PDF pays the
            // same toll in rasterisation instead: `PdfPageView` watches its own
            // wrapper, so an unpinned pane re-renders every page on screen once
            // per frame, at 50–150 ms each on an illustrated book.
            //
            // `flexBasis`, not `width`: this box is `flex-1`, so its
            // `flex-basis` is `0%` and a `width` on a flex item with a
            // definite basis is ignored outright — the width pin was silently
            // doing nothing. `flexGrow`/`flexShrink` have to go to 0 as well,
            // or the box grows straight back to the pane's new width.
            ...(pinnedW !== null && (useFoliate || isPdf)
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
          <ReaderChapterView
            bookId={bookId}
            isPdf={isPdf}
            useFoliate={useFoliate}
            paged={paged}
            doublePage={layoutMode === "double"}
            chapterIdx={chapterIdx}
            total={total}
            transitionClass={transitionClass}
            margin={margin}
            blockMargin={blockMargin}
            images={bookImages}
            onOpenImage={openImageAt}
            foliateRef={foliateRef}
            pdf={{
              gap: pdfGap,
              zoom: pdfZoom,
              animated: pdfZoomAnimated,
              night: pdfNight,
              invertImages: pdfInvertImages,
              annotationsByPage,
              wash: readAloud.pdfWash,
              onSelection: onPdfSelection,
              onAnnotationClick: onPdfAnnotationClick,
              onLayout: handlePdfLayout,
            }}
            foliate={{
              format,
              startCfi,
              startFraction: startCfi ? null : initialProgress,
              layout: layoutMode,
              transition: pageTransition,
              style: foliateStyle,
              annotations,
              onSelect: onFoliateSelection,
              onAnnotationClick: onFoliateAnnotationClick,
              onAnchor: onFoliateAnchor,
              onImageOpen: openBookImage,
              onLocationChange: (relocate) => {
                rememberFoliateLocation(relocate);
                // A page turn moves the words, not the toolbar: re-anchor it.
                // Only worth measuring while there is one to move.
                if (toolbarOpen) remeasureSelection();
              },
              onTocLoaded: setFoliateToc,
            }}
            plate={{ image: plate }}
            prose={{
              pending: chapter.isPending,
              paragraphs: renderedParagraphs,
              gap: PARA_GAPS[paraGapIdx],
              indent,
              invertImages: invertBookImages,
              darkSurface: surface.mode === "dark",
              style: articleStyle,
              annotations,
              onGoTo: goTo,
              onEditAnnotation: (annotation, x, y) =>
                setPending({
                  range: {
                    start: annotation.startChar,
                    end: annotation.endChar,
                    text: annotation.text,
                  },
                  x,
                  y,
                  annotationId: annotation.id,
                }),
              ink: markInk,
            }}
          />
          {/* Pull-to-bookmark. The prose scroller only: whether the page is at
            its top is the gesture's whole premise, and that is a scrollTop
            only this path owns — foliate and the PDF view keep their own
            scrollers, where a downward drag is a scroll up the page. */}
          <PullBookmark
            hostRef={viewportRef}
            scrollRef={scrollRef}
            enabled={!paged && !useFoliate && !isPdf}
            onTrigger={addBookmark}
          />
          {paged && tail && (
            <div
              aria-hidden
              data-tail-pad
              className="pointer-events-none absolute top-0 h-px"
              style={{ left: tail.left, width: tail.width }}
            />
          )}
        </div>

        {/* Reading ruler: a band parked at the reader's place, with the rest of
          the page washed toward the paper. A sibling of the scroller, not a
          child — a paged chapter is a long strip inside a moving window, and a
          ruler inside it would be carried off with the page that just left.
          Its body is inert, so only its two edges ever take a pointer (see
          `ReadingRuler`). */}
        <ReadingRuler
          ref={rulerRef}
          hostRef={viewportRef}
          enabled={settings.readingRuler}
          vertical={readsLeftward}
          columns={!readsLeftward && layoutMode === "double" ? 2 : 1}
          pitch={fontSize * (LINE_HEIGHTS[lineHeightIdx] ?? 1.8)}
          scrim={surface.tint}
          ink={surface.fg}
          lines={useFoliate ? foliateRulerLines : undefined}
        />

        {/* Page indicator (settings-gated) and a hairline progress rail that
            surfaces on activity and fades out after 2s of stillness. Above the
            ruler's wash, which covers the page bottom along with everything
            else outside the band. */}
        {paged && shownPages && (
          <p
            data-page-indicator
            className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 text-xs tabular-nums opacity-70"
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
              // Hovering chrome sitting on top of the pane, so a native
              // snapshot of the pane would capture it: masked while one is
              // taken (see `data-turn-mask` in globals.css).
              data-turn-overlay
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
              data-turn-overlay
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
          open={readAloud.playerOpen}
          onOpenChange={readAloud.setPlayerOpen}
          title={title}
          coverUrl={coverUrl}
          chapter={headerChapter}
          units={readAloud.units}
          index={readAloud.unit}
          status={readAloud.status}
          error={readAloud.error}
          loading={readAloud.loading}
          rate={speechRate}
          onRate={(value) => readAloud.applySettings({ rate: value })}
          voiceUri={readAloud.voiceUri}
          onVoice={(uri) => readAloud.applySettings({ voice: uri })}
          bookLanguage={bookLanguage}
          sleep={sleep}
          onSleep={chooseSleep}
          onToggle={readAloud.toggle}
          onStop={readAloud.stop}
          onStep={readAloud.step}
          onSkip={readAloud.skip}
          onSeek={readAloud.seek}
        />

        {/* Speed reading: takes the whole reading area while it runs, and
            hands it back on close — the page is the same page underneath. */}
        {readAloud.rsvpOpen && (
          <RsvpPlayer
            onClose={readAloud.closeRsvp}
            tokens={readAloud.rsvpWords}
            chapter={headerChapter}
            wpm={rsvpWpm}
            onWpm={(value) => settings.update({ rsvpWpm: value })}
            onNextChapter={() => stepChapter(1)}
            hasNextChapter={chapterIdx < total - 1}
            background={surface.background}
          />
        )}
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
                  readAloud.speakFromSelection(pending.range);
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

      <ReaderPanels
        panel={panel}
        bookId={bookId}
        verticalAvailable={useFoliate}
        // The drawer's own ✕. Same call as Escape's, so the two cannot drift
        // apart again — that drift is what left the highlights painted.
        onClose={closePanel}
        toc={{
          chapters: useFoliateToc ? foliateChapters : chapters,
          outline,
          currentIdx: useFoliateToc ? foliateTocIdx : chapterIdx,
          bookmarks: bookmarks ?? [],
          busy: createBookmark.isPending || deleteBookmark.isPending,
          onJump: (idx) => {
            setPanel("none");
            if (useFoliateToc) {
              foliateRef.current?.goToEntry(idx);
              return;
            }
            goTo(idx);
          },
          onJumpBookmark: (bookmark: Bookmark) => {
            setPanel("none");
            jumpTo(bookmark.chapterIdx, bookmark.fraction ?? 0);
          },
          onDeleteBookmark: (id) => deleteBookmark.mutate(id),
          onAddBookmark: addBookmark,
        }}
        graph={{
          onOpenChapter: (idx) => {
            setPanel("none");
            goTo(idx);
          },
        }}
        search={{
          useFoliate,
          seed: searchSeed,
          onFoliateSearch: (query) => foliateRef.current?.search(query) ?? Promise.resolve([]),
          onFoliatePick: (cfi) => {
            setPanel("none");
            foliateRef.current?.goToCfi(cfi);
          },
          onPick: (hit, needle) => {
            setSearch(needle);
            pickHit(hit);
          },
        }}
        annotations={{
          items: annotations ?? [],
          busy: deleteAnnotation.isPending || setAnnotationNote.isPending,
          onDelete: (id) => deleteAnnotation.mutate(id),
          onNote: (id, note) => setAnnotationNote.mutate({ id, note }),
          onExport: () => setExportingNotes(true),
          onJump: useFoliate
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
            : undefined,
        }}
        ai={{
          context: aiContext,
          onClearContext: () => setAiContext(null),
          chapterTitle: chapterTitle || `第 ${chapterIdx + 1} 章`,
          paragraphs: chapterData?.paragraphs ?? [],
          onJumpCitation: jumpToCitation,
        }}
      />

      {/* Lightbox viewer: blank areas close, Esc closes, arrows flip the book's images. */}
      <OverlayPortal>
        <AnimatePresence>
          {lightboxIdx !== null && lightboxIdx >= 0 && (
            <ImageLightbox
              bookId={bookId}
              images={bookImages}
              urls={urls}
              chapters={chapters}
              index={lightboxIdx}
              onClose={closeLightbox}
              onIndex={openImageAt}
              onJump={(target) => {
                closeLightbox();
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
            onConfirm={(path, exportFormat) =>
              exportNotes.mutate(
                { id: bookId, name: title, path, format: exportFormat },
                { onSuccess: () => setExportingNotes(false) },
              )
            }
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * What the 返回 button is called, by the route it goes back to.
 *
 * The shelf routes are absent on purpose: they all read "返回书库", which is
 * what the button has always said and what every shelf-side test looks for.
 */
const BACK_LABELS: Record<string, string> = {
  "/notes": "返回笔记",
  "/search": "返回搜索",
  "/stats": "返回统计",
};

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
  // Where this book was opened from. The shell wrote it down on the way in.
  const returnPath = useChrome((s) => s.readerReturnPath);
  const backLabel = BACK_LABELS[returnPath] ?? "返回书库";
  const goBack = useCallback(() => navigate(returnPath), [navigate, returnPath]);
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
            <GlassButton variant="subtle" onClick={goBack}>
              {backLabel}
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
    goBack,
    backLabel,
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
            <GlassButton variant="subtle" onClick={goBack}>
              {backLabel}
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
      backLabel={backLabel}
      onBack={goBack}
    />
  );
}
