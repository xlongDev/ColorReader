import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowsOut,
  ArrowsIn,
  DownloadSimple,
  ArrowLeft,
  ArrowDown,
  BookOpen,
  CaretLeft,
  CaretRight,
  Faders,
  Graph,
  HighlighterCircle,
  ListBullets,
  MagnifyingGlass,
  Pause,
  SpeakerHigh,
  Stop,
  Trash,
  X,
} from "@phosphor-icons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  paragraphAt,
  resolveSelection,
  type TextRange,
} from "@/features/reader/selection";
import { useTts } from "@/features/reader/tts";
import { resolveFont, resolveSurface, type LayoutMode } from "@/features/reader/theme";
import { SearchPanel } from "@/features/search/SearchPanel";
import { useAnnotations, useCreateAnnotation, useDeleteAnnotation } from "@/hooks/useAnnotations";
import { useBookmarks, useCreateBookmark, useDeleteBookmark } from "@/hooks/useBookmarks";
import { useAiChat } from "@/hooks/useAi";
import { useIndexBook, useRagStatus } from "@/hooks/useRag";
import {
  useBook,
  useBookImages,
  useChapter,
  useReaderToc,
  useSetProgress,
} from "@/hooks/useReader";
import {
  AUTO_SCROLL_SPEEDS,
  LINE_HEIGHTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  PAGE_MARGINS,
  PARA_GAPS,
  updateReadingSpeed,
  useReaderSettings,
} from "@/stores/reader";
import { useChrome } from "@/stores/chrome";
import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import type { Annotation, BookImage, Bookmark, ChapterMeta, RagHit, SearchHit } from "@/types/ipc";

/** How long to wait after scrolling stops before persisting the position. */
const SAVE_DELAY_MS = 600;

/** Gutter between the two columns of a spread. */
const SPREAD_GAP = 72;

/** Wheel silence (ms) that ends one trackpad gesture and re-arms paging. */
const GESTURE_GAP = 200;

/**
 * Books look right with breathing room: paged modes enforce a generous floor
 * on the page margin (the user's setting can only widen it), Apple Books style.
 */
const MIN_PAGE_MARGIN = 48;

/** A paragraph starting with this marker renders as an in-book image. */
const IMAGE_PARAGRAPH_PREFIX = "￼";

/** Page margin actually applied: the user's choice, floored in paged modes. */
function effectiveMargin(mode: LayoutMode, margin: number): number {
  return mode === "scroll" ? margin : Math.max(margin, MIN_PAGE_MARGIN);
}

/** Paragraph list for the voice: image placeholders speak as nothing. */
function speakable(paragraphs: string[]): string[] {
  return paragraphs.map((paragraph) =>
    paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX) ? "" : paragraph,
  );
}

/** Which side panel is open. Only one at a time, so they never stack. */
type Panel = "none" | "annotations" | "search" | "ai" | "graph" | "toc" | "settings";

/** Distance between neighbouring column boundaries in a paged layout (px). */
function columnPitch(el: HTMLDivElement, mode: LayoutMode, margin: number): number {
  const content = el.clientWidth - effectiveMargin(mode, margin) * 2;
  const colWidth = mode === "double" ? (content - SPREAD_GAP) / 2 : content;
  return colWidth + SPREAD_GAP;
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

interface ReaderViewProps {
  bookId: string;
  title: string;
  chapters: ChapterMeta[];
  initialProgress: number;
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
  chapters,
  initialProgress,
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
    marginIdx,
    indent,
    surface: surfaceKey,
    customSurface,
    pageTransition,
    layoutMode,
    autoScrollIdx,
    readingSpeed,
    setReadingSpeed,
    showPageNumbers,
  } = settings;
  const speechRate = settings.speechRate;
  const setSpeechRate = settings.setSpeechRate;
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
    paragraph: speechParagraph,
    play,
    stop,
    pause,
    resume,
    setRate,
  } = useTts();

  const annotations = annotationsQuery.data;
  const bookmarks = bookmarksQuery.data;
  const [panel, setPanel] = useState<Panel>("none");
  const [search, setSearch] = useState(initialQuery);
  const [pending, setPending] = useState<{ range: TextRange; x: number; y: number } | null>(null);
  // Quoted text for the AI drawer; `null` means "use the whole chapter".
  const [aiContext, setAiContext] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [autoScrolling, setAutoScrolling] = useState(false);

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

  const scrollRef = useRef<HTMLDivElement>(null);
  // Fraction to apply once the current chapter body has rendered. Starts at the
  // saved position, then is reset to the top of the chapter on navigation.
  const pendingScroll = useRef<number>(start.fraction);
  // Offset of a search hit to reveal instead of the scroll fraction.
  const pendingFocus = useRef<number | null>(initialOffset);
  const debounceRef = useRef<number | null>(null);
  // Latest position along the active axis, read outside the scroll handler.
  const fractionRef = useRef<number>(start.fraction);
  // Mirror of the layout mode so scroll-dependent callbacks never go stale;
  // kept in sync by the layout effect below.
  const layoutModeRef = useRef<LayoutMode>(layoutMode);
  // Same trick for the page margin: it sets the column pitch. Synced by an
  // effect below, mirroring layoutModeRef.
  const marginRef = useRef<number>(PAGE_MARGINS[marginIdx]!);
  /** Viewport width, drives the column layout of paged modes. */
  const [viewportW, setViewportW] = useState(0);
  /** Previous progress sample for the sustained reading speed estimate. */
  const speedSampleRef = useRef<{ at: number; chars: number } | null>(null);
  /** Hover-reveal flip affordance for paged modes; hides itself after 2s idle. */
  const [flipHint, setFlipHint] = useState(false);
  /** 1-based position inside the chapter's column count, for the page indicator. */
  const [pageInfo, setPageInfo] = useState<{ page: number; pages: number } | null>(null);
  /** Book image opened in the lightbox viewer, an index into the book-wide `bookImages`. */
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const flipHintTimer = useRef<number | null>(null);
  const revealFlipHint = useCallback(() => {
    setFlipHint(true);
    if (flipHintTimer.current !== null) window.clearTimeout(flipHintTimer.current);
    flipHintTimer.current = window.setTimeout(() => setFlipHint(false), 2000);
  }, []);
  useEffect(
    () => () => {
      if (flipHintTimer.current !== null) window.clearTimeout(flipHintTimer.current);
    },
    [],
  );

  const chapter = useChapter(bookId, chapterIdx);
  const bookImagesQuery = useBookImages(bookId);
  const bookImages = bookImagesQuery.data ?? [];

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
      pendingScroll.current = 0;
      const progress = globalProgress(chapters, clamped, 0);
      setProgress(progress);
      setDisplayProgress(progress);
      setFraction(0);
      fractionRef.current = 0;
      setAutoScrolling(false);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [chapters, chapterIdx, setProgress, stop],
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
    if (chapterIdx < chapters.length - 1) {
      autoAdvance.current = true;
      goTo(chapterIdx + 1);
    }
  }, [chapterIdx, chapters.length, goTo]);

  // Set when the voice rolls off the end of a chapter, consumed by the
  // position effect below once the next chapter has rendered.
  const applyPending = useCallback(
    (el: HTMLDivElement) => {
      const focus = pendingFocus.current;
      pendingFocus.current = null;
      const frac = pendingScroll.current;
      pendingScroll.current = 0;
      const paragraphs = chapter.data?.paragraphs ?? [];
      const continueSpeech = autoAdvance.current;
      autoAdvance.current = false;
      if (continueSpeech) play(speakable(paragraphs), 0, onChapterEnd);
      if (focus !== null) {
        const target = paragraphAt(paragraphs, focus);
        el.querySelector(`[data-para-idx="${target}"]`)?.scrollIntoView({ block: "center" });
        return;
      }
      applyPosition(el, frac, layoutModeRef.current, marginRef.current);
    },
    [chapter.data, onChapterEnd, play],
  );

  // Apply the pending position once the chapter body has rendered: a search hit
  // scrolls its paragraph to the middle, otherwise the saved fraction applies.
  // Auto-advance rides along: the voice restarts at paragraph zero of the new
  // chapter inside the same frame the body appears.
  useEffect(() => {
    if (chapter.data == null) return;
    const el = scrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => applyPending(el));
    return () => cancelAnimationFrame(frame);
  }, [chapter.data, applyPending]);

  // Switching layout mode re-anchors the same reading position on the new axis.
  useEffect(() => {
    layoutModeRef.current = layoutMode;
    const el = scrollRef.current;
    if (el) applyPosition(el, fractionRef.current, layoutMode, marginRef.current);
  }, [layoutMode]);

  // Keep the margin mirror fresh; margin is not needed for rendering effects.
  useEffect(() => {
    marginRef.current = PAGE_MARGINS[marginIdx]!;
  }, [marginIdx]);

  // Track the viewport width; paged modes lay the chapter out in columns and
  // re-anchor the position whenever the columns re-flow.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewportW(el.clientWidth);
      if (layoutModeRef.current !== "scroll") {
        requestAnimationFrame(() =>
          applyPosition(el, fractionRef.current, layoutModeRef.current, marginRef.current),
        );
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const paged = layoutMode !== "scroll";

  /** Flips one page in a paged layout; rolls into the neighbouring chapter at the edges. */
  const flip = useCallback(
    (dir: 1 | -1) => {
      const el = scrollRef.current;
      if (!el) return;
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
        el.scrollBy({ left: dir * el.clientWidth, behavior: "smooth" });
        return;
      }
      const target = (Math.round(pos / pitch) + dir * page) * pitch;
      el.scrollTo({ left: Math.max(0, Math.min(target, max)), behavior: "smooth" });
    },
    [chapterIdx, goTo],
  );

  // In paged modes the wheel flips whole pages instead of nudging pixels:
  // free pixel scrolling always ends between two columns.
  useEffect(() => {
    if (layoutMode === "scroll") return;
    const el = scrollRef.current;
    if (!el) return;
    let acc = 0;
    let lastEventAt = 0;
    let flipped = false;
    const onWheel = (event: WheelEvent) => {
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
  }, [flip, layoutMode]);

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
      if (event.key === "Escape" && fullscreen) {
        void toggleFullscreen();
        return;
      }
      if (paged && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        flip(event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (event.key === "ArrowRight") goTo(chapterIdx + 1);
      if (event.key === "ArrowLeft") goTo(chapterIdx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chapterIdx, bookImages.length, flip, fullscreen, goTo, lightboxIdx, paged, toggleFullscreen]);

  // Auto-scroll: advances the viewport along the active axis until it runs out.
  useEffect(() => {
    if (!autoScrolling) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const pagedNow = layoutModeRef.current !== "scroll";
      if (pagedNow) el.scrollLeft += AUTO_SCROLL_SPEEDS[autoScrollIdx]! * dt;
      else el.scrollTop += AUTO_SCROLL_SPEEDS[autoScrollIdx]! * dt;
      const max = pagedNow ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
      const pos = pagedNow ? el.scrollLeft : el.scrollTop;
      if (pos >= max - 1) {
        setAutoScrolling(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoScrolling, autoScrollIdx]);

  // The hook reads the rate from a ref, so a change lands on the next paragraph.
  useEffect(() => {
    setRate(speechRate);
  }, [speechRate, setRate]);

  // Follow the voice: `nearest` only scrolls when the paragraph is fully out
  // of view, so skimming ahead is never yanked back.
  useEffect(() => {
    if (speechParagraph === null) return;
    scrollRef.current
      ?.querySelector(`[data-para-idx="${speechParagraph}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [speechParagraph]);

  const toggleSpeech = () => {
    if (speechStatus === "playing") {
      pause();
      return;
    }
    if (speechStatus === "paused") {
      resume();
      return;
    }
    const paragraphs = chapter.data?.paragraphs;
    if (paragraphs) play(speakable(paragraphs), 0, onChapterEnd);
  };

  const saveProgress = useCallback(
    (frac: number) => {
      const progress = globalProgress(chapters, chapterIdx, frac);
      setProgress(progress);
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
  }, [chapters, chapterIdx, saveProgress, showPageNumbers]);

  // Recompute the page indicator when the setting or layout flips without a
  // scroll event; chapter switches and resizes re-report through `onScroll`.
  useEffect(() => {
    if (!paged || !showPageNumbers) return;
    const el = scrollRef.current;
    if (!el) return;
    const pageMargin = Math.max(PAGE_MARGINS[marginIdx]!, MIN_PAGE_MARGIN);
    const pitch = columnPitch(el, layoutMode, pageMargin);
    const max = el.scrollWidth - el.clientWidth;
    if (pitch <= 0) return;
    setPageInfo({
      page: Math.round(el.scrollLeft / pitch) + 1,
      pages: Math.round(max / pitch) + 1,
    });
  }, [layoutMode, marginIdx, paged, showPageNumbers]);

  // Flush a pending save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  // A mouse-up over the article turns a completed selection into a pending
  // highlight, surfaced as a floating "高亮" button rather than saving blind.
  // The listener is attached through a ref so the reading viewport stays a plain
  // semantic scroll container instead of a synthetic widget.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || !chapter.data) {
        setPending(null);
        return;
      }
      const range = resolveSelection(selection, chapter.data.paragraphs);
      if (!range) {
        setPending(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setPending({ range, x: rect.left + rect.width / 2, y: rect.top });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [chapter.data]);

  const createHighlight = (range: TextRange) => {
    createAnnotation.mutate(
      { chapterIdx, startChar: range.start, endChar: range.end, text: range.text },
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

  /** Reveals a character offset of the chapter already on screen. */
  const focusOffset = useCallback(
    (offset: number) => {
      const paragraphs = chapter.data?.paragraphs;
      const el = scrollRef.current;
      if (!paragraphs || !el) return;
      const target = paragraphAt(paragraphs, offset);
      el.querySelector(`[data-para-idx="${target}"]`)?.scrollIntoView({ block: "center" });
    },
    [chapter.data],
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
  const chapterTitle = chapter.data?.title ?? "";
  const surface = resolveSurface(surfaceKey, customSurface);
  const margin = effectiveMargin(layoutMode, PAGE_MARGINS[marginIdx]!);

  /** Column width for the paged layouts; `undefined` keeps flow layout. */
  const columnWidth = useMemo(() => {
    if (!paged || viewportW <= 0) return undefined;
    const content = viewportW - margin * 2;
    return layoutMode === "double" ? (content - SPREAD_GAP) / 2 : content;
  }, [layoutMode, margin, paged, viewportW]);

  const chapterRemaining = Math.max(
    0,
    Math.round((chapters[chapterIdx]?.chars ?? 0) * (1 - fraction)),
  );
  const bookRemaining = remainingChars(chapters, chapterIdx, fraction);

  const addBookmark = () => {
    createBookmark.mutate({
      chapterIdx,
      fraction: fractionRef.current,
      label: `${chapterTitle || `第 ${chapterIdx + 1} 章`} · ${Math.round(fractionRef.current * 100)}%`,
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
    color: surface.fg,
    paddingInline: margin,
    // Paged layouts breathe like a paper page: real margins on all four
    // sides, not just left/right.
    ...(columnWidth !== undefined
      ? {
          height: "100%",
          paddingBlock: margin,
          columnWidth,
          columnGap: SPREAD_GAP,
          columnFill: "auto",
        }
      : {}),
  };

  // Split the chapter into paragraph segments, wrapping the parts covered by an
  // annotation or a search match in a highlight. Keys are built here (outside
  // the JSX map) so the render lists never use a raw index key.
  const renderedParagraphs = useMemo(() => {
    const paragraphs = chapter.data?.paragraphs ?? [];
    const chapterAnnotations = (annotations ?? []).filter((a) => a.chapterIdx === chapterIdx);
    return paragraphs.map((paragraph, idx) => ({
      idx,
      key: `${chapterIdx}-${idx}`,
      // An image marker renders as the referenced picture; it has no text.
      imagePath: paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX)
        ? paragraph.slice(IMAGE_PARAGRAPH_PREFIX.length)
        : null,
      segments: highlightSegments(paragraphs, idx, chapterAnnotations, search).map(
        (segment, position) => ({
          key: `${chapterIdx}-${idx}-${position}`,
          text: segment.text,
          highlighted: segment.highlighted,
        }),
      ),
    }));
  }, [chapter.data, chapterIdx, annotations, search]);

  // Shared header bar: rendered in flow normally, and dropped from the top
  // edge on hover while in fullscreen.
  const headerBar = (
    <header
      className="border-hairline flex items-center gap-3 border-b px-6 py-3"
      style={fullscreen ? { background: surface.background } : undefined}
    >
      <GlassIconButton label="返回书库" size="sm" onClick={onBack}>
        <ArrowLeft size={16} />
      </GlassIconButton>
      <div className="min-w-0 flex-1">
        <p className="text-text-1 truncate text-sm font-medium">{title}</p>
        <p className="text-text-3 truncate text-xs">
          第 {chapterIdx + 1} / {total} 章{chapterTitle && ` · ${chapterTitle}`}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <GlassIconButton
          label="目录与书签"
          size="sm"
          onClick={() => setPanel((open) => (open === "toc" ? "none" : "toc"))}
        >
          <ListBullets size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="搜索"
          size="sm"
          onClick={() => setPanel((open) => (open === "search" ? "none" : "search"))}
        >
          <MagnifyingGlass size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="标注"
          size="sm"
          onClick={() => setPanel((open) => (open === "annotations" ? "none" : "annotations"))}
        >
          <HighlighterCircle size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="知识图谱"
          size="sm"
          onClick={() => setPanel((open) => (open === "graph" ? "none" : "graph"))}
        >
          <Graph size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="阅读设置"
          size="sm"
          onClick={() => setPanel((open) => (open === "settings" ? "none" : "settings"))}
        >
          <Faders size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="缩小字号"
          size="sm"
          onClick={() => setFontSize(fontSize - 1)}
          disabled={fontSize <= MIN_FONT_SIZE}
        >
          <span className="text-[11px] font-semibold">A</span>
        </GlassIconButton>
        <GlassIconButton
          label="放大字号"
          size="sm"
          onClick={() => setFontSize(fontSize + 1)}
          disabled={fontSize >= MAX_FONT_SIZE}
        >
          <span className="text-sm font-semibold">A</span>
        </GlassIconButton>
        <GlassIconButton
          label={fullscreen ? "退出全屏" : "全屏阅读"}
          size="sm"
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
        </GlassIconButton>
      </div>
    </header>
  );

  return (
    <div className="flex h-full flex-col">
      {!fullscreen ? (
        headerBar
      ) : (
        // Fullscreen: the toolbar lives above the top edge and slides in only
        // while the pointer rests on the top strip of the reading area.
        <div className="group/hud absolute inset-x-0 top-0 z-40 h-12">
          <div className="-translate-y-full opacity-0 transition-all duration-200 ease-out group-hover/hud:translate-y-0 group-hover/hud:opacity-100 motion-reduce:transition-none">
            {headerBar}
          </div>
        </div>
      )}

      {/* Reading viewport. In paged modes the flip arrows reveal on hover or
          pointer-down and fade out after 2s, so they never sit on the text. */}
      <div
        className="relative flex min-h-0 flex-1"
        onMouseMove={revealFlipHint}
        onPointerDown={revealFlipHint}
        onMouseLeave={() => setFlipHint(false)}
      >
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn(
            "min-h-0 flex-1",
            paged ? "overflow-x-auto overflow-y-hidden" : "overflow-y-auto",
          )}
          style={{ background: surface.background }}
        >
          <article
            key={chapterIdx}
            className={cn("prose-reader mx-auto", !paged && "max-w-2xl py-10", transitionClass)}
            style={articleStyle}
          >
            {chapter.isPending ? (
              <p className="text-sm opacity-60">正在加载章节…</p>
            ) : (
              renderedParagraphs.map(({ idx, key, imagePath, segments }) =>
                imagePath !== null ? (
                  <p key={key} data-para-idx={idx} className="my-6 text-center">
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
                    className={cn(
                      "text-pretty",
                      speechParagraph === idx && "bg-accent-soft -mx-2 rounded-lg px-2",
                    )}
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
                      segment.highlighted ? (
                        <mark
                          key={segment.key}
                          className="bg-accent-soft rounded-[2px] text-inherit"
                        >
                          {segment.text}
                        </mark>
                      ) : (
                        segment.text
                      ),
                    )}
                  </p>
                ),
              )
            )}
          </article>
        </div>

        {/* Page indicator (settings-gated) and a hairline progress rail that
            surfaces on activity and fades out after 2s of stillness. */}
        {paged && showPageNumbers && pageInfo && (
          <p
            className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 text-xs tabular-nums opacity-70"
            style={{ color: surface.fg }}
          >
            {pageInfo.page} / {pageInfo.pages} 页
          </p>
        )}
        <div
          className={cn(
            "bg-accent absolute bottom-0 left-0 z-10 h-0.5 transition-opacity duration-300 motion-reduce:transition-none",
            flipHint ? "opacity-100" : "opacity-0",
          )}
          style={{ width: `${Math.round(displayProgress * 100)}%` }}
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
      </div>

      {fullscreen ? (
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          className="glass-solid shadow-panel text-text-2 hover:text-text-1 absolute bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full px-4 py-1.5 text-xs transition-colors"
        >
          退出全屏（Esc）
        </button>
      ) : (
        <footer className="border-hairline flex items-center justify-center gap-3 border-t px-6 py-3">
          <GlassIconButton
            label={
              speechStatus === "paused"
                ? "继续朗读"
                : speechStatus === "playing"
                  ? "暂停朗读"
                  : "朗读本章"
            }
            size="sm"
            onClick={toggleSpeech}
          >
            {speechStatus === "playing" ? <Pause size={16} /> : <SpeakerHigh size={16} />}
          </GlassIconButton>
          {speechStatus !== "idle" && (
            <GlassIconButton label="停止朗读" size="sm" onClick={stop}>
              <Stop size={16} />
            </GlassIconButton>
          )}
          <GlassIconButton
            label={`语速 ${speechRate} 倍，点击切换`}
            size="sm"
            onClick={() => setSpeechRate(speechRate)}
          >
            <span className="text-[11px] font-semibold">{speechRate}×</span>
          </GlassIconButton>
          <GlassIconButton
            label={autoScrolling ? "暂停自动滚动" : "开始自动滚动"}
            size="sm"
            onClick={() => setAutoScrolling((on) => !on)}
          >
            {autoScrolling ? <Pause size={16} /> : <ArrowDown size={16} />}
          </GlassIconButton>
          <GlassButton
            variant="subtle"
            size="sm"
            onClick={() => goTo(chapterIdx - 1)}
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
            onClick={() => goTo(chapterIdx + 1)}
            disabled={chapterIdx >= total - 1}
          >
            下一章 <CaretRight size={14} />
          </GlassButton>
          <span className="text-text-3 text-xs">{paged ? "← → 翻页" : "← → 翻章"}</span>
        </footer>
      )}

      {pending && (
        <div
          className="fixed z-40 -translate-x-1/2"
          style={{ left: pending.x, top: pending.y - 44 }}
        >
          <div className="glass-2 shadow-panel flex items-center overflow-hidden rounded-full">
            <button
              type="button"
              onClick={() => createHighlight(pending.range)}
              className="bg-accent text-on-accent px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
            >
              高亮
            </button>
            <button
              type="button"
              onClick={() => askAboutSelection(pending.range)}
              className="text-text-1 hover:text-accent border-hairline px-3 py-1.5 text-xs font-medium transition-colors"
            >
              问 AI
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

      {panel === "toc" && (
        <ReaderDrawer title="目录与书签" onClose={() => setPanel("none")}>
          <TocPanel
            chapters={chapters}
            currentIdx={chapterIdx}
            bookmarks={bookmarks ?? []}
            busy={createBookmark.isPending || deleteBookmark.isPending}
            onJump={(idx) => {
              setPanel("none");
              goTo(idx);
            }}
            onJumpBookmark={(bookmark: Bookmark) => {
              setPanel("none");
              jumpTo(bookmark.chapterIdx, bookmark.fraction);
            }}
            onDeleteBookmark={(id) => deleteBookmark.mutate(id)}
            onAddBookmark={addBookmark}
          />
        </ReaderDrawer>
      )}

      {panel === "settings" && (
        <ReaderDrawer title="阅读设置" onClose={() => setPanel("none")}>
          <SettingsPanel />
        </ReaderDrawer>
      )}

      {panel === "annotations" && (
        <ReaderDrawer title="标注" onClose={() => setPanel("none")}>
          <AnnotationList
            annotations={annotations ?? []}
            busy={deleteAnnotation.isPending}
            onDelete={(id) => deleteAnnotation.mutate(id)}
          />
        </ReaderDrawer>
      )}

      {panel === "search" && (
        <ReaderDrawer
          title="搜索正文"
          onClose={() => {
            setSearch("");
            setPanel("none");
          }}
        >
          <SearchPanel
            bookId={bookId}
            onPick={(hit, needle) => {
              setSearch(needle);
              pickHit(hit);
            }}
          />
        </ReaderDrawer>
      )}

      {panel === "graph" && (
        <ReaderDrawer title="知识图谱" onClose={() => setPanel("none")}>
          <GraphPanel
            bookId={bookId}
            onOpenChapter={(idx) => {
              setPanel("none");
              goTo(idx);
            }}
          />
        </ReaderDrawer>
      )}

      {panel === "ai" && (
        <ReaderDrawer title="AI 助手" onClose={() => setPanel("none")}>
          <AskAiPanel
            bookId={bookId}
            selection={aiContext}
            onClearSelection={() => setAiContext(null)}
            chapterTitle={chapterTitle || `第 ${chapterIdx + 1} 章`}
            paragraphs={chapter.data?.paragraphs ?? []}
            onJump={jumpToCitation}
          />
        </ReaderDrawer>
      )}

      {/* Lightbox viewer: blank areas close, Esc closes, arrows flip the book's images. */}
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

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([buffer], { type: assetMime(path) }));
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
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/85 p-8">
      <button
        type="button"
        aria-label="关闭预览"
        className="absolute inset-0 cursor-zoom-out"
        onClick={onClose}
      />
      {/* Blank space passes through (pointer-events-none) to the close button
          underneath, so clicking anywhere outside the picture dismisses it. */}
      <div className="pointer-events-none relative flex min-h-0 flex-1 items-center justify-center">
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
          <img
            src={src}
            alt=""
            className="shadow-panel pointer-events-auto max-h-full max-w-full rounded-xl object-contain"
            draggable={false}
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
      <div className="relative mt-5 flex items-center justify-center gap-3">
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
    </div>
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
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/jpeg";
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
}: {
  bookId: string;
  path: string;
  onOpen: (src: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([buffer], { type: assetMime(path) }));
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookId, path]);

  if (!src) return null;
  return (
    <button
      type="button"
      aria-label="查看图片"
      onClick={() => onOpen(src)}
      className="cursor-zoom-in transition-opacity hover:opacity-90"
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        className="border-hairline mx-auto max-w-full rounded-lg border"
        draggable={false}
      />
    </button>
  );
}

/** Right-hand drawer shared by the annotation list and the search panel. */ function ReaderDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="fixed inset-y-0 right-0 z-40 w-80 max-w-[85vw] p-3">
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
    </aside>
  );
}

function AnnotationList({
  annotations,
  busy,
  onDelete,
}: {
  annotations: Annotation[];
  busy: boolean;
  onDelete: (id: string) => void;
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
                <p className="text-text-3 text-xs">第 {annotation.chapterIdx + 1} 章</p>
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
              <p className="text-text-1 mt-1 text-[13px] leading-relaxed">{annotation.text}</p>
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
      chapters={chapters}
      initialProgress={bookSummary.progress}
      initialChapter={initialChapter}
      initialQuery={initialQuery}
      initialOffset={initialOffset}
      onBack={() => navigate("/")}
    />
  );
}
