import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  FoliateLocation,
  FoliateSelection,
  FoliateTocEntry,
} from "@/features/reader/FoliateBookView";
import { POSITION_SAVE_DELAY_MS, locateChapter } from "@/features/reader/progress";
import type { PendingSelection } from "@/features/reader/selection";
import type { Annotation, ChapterMeta } from "@/types/ipc";

/**
 * The book as foliate reports it: its own table of contents, its own position,
 * and the three things the view hands back.
 *
 * `FoliateBookView` keeps a book's own XHTML and CSS — that is the whole point
 * of it — and the price is that foliate's sections are the container's own
 * spine items, not the chapters our importer split the same book into. Nothing
 * here can be derived from the chapter list, so it all has to be asked for:
 *
 * - **Where the reader is.** foliate reports a whole-book fraction, which is
 *   the honest one (our 51-chapter estimate drifts badly on a Kindle file) and
 *   is why the report writes the spine's position rather than only its own
 *   state. The CFI it carries is the only anchor that survives a section
 *   change, so it is also what gets persisted.
 * - **What the book calls its parts.** A nested TOC, reshaped into the same
 *   chapter list the drawer already reads.
 * - **What the reader touched.** A selection, a click on a painted highlight,
 *   and a CFI the view found for a highlight that arrived without one — an
 *   import from a clippings file knows only the text it quotes.
 *
 * What is *not* here is the handle itself: `foliateRef` is shared with the
 * navigation, the ruler and the read-aloud layer, so it stays with the page.
 * This hook only owns what the view tells us and where we put it.
 */

export interface FoliateBookOptions {
  /** Whether this book renders through foliate at all. */
  useFoliate: boolean;
  /**
   * The chapters our importer split the book into.
   *
   * Needed for one thing only: foliate's whole-book fraction is the better
   * position, and landing it on a chapter index is what the AI drawer quotes
   * and the remaining-time labels count from.
   */
  chapters: ChapterMeta[];
  /** The spine's chapter index. foliate's fraction is the better answer. */
  setChapterIdx: (idx: number) => void;
  /** The spine's whole-book progress. */
  setDisplayProgress: (fraction: number) => void;
  /**
   * The spine's progress write, which carries the CFI to the database.
   *
   * Narrower than the mutation it comes from: the location is the only thing
   * this hook has to say about progress, so it takes the one shape it writes
   * rather than the whole `mutate`.
   */
  setProgress: (progress: { progress: number; location?: string }) => void;
  /** The retired localStorage slot the CFI used to park in. */
  cfiKey: string;
  /** The spine's pending selection — the toolbar's own state. */
  setPending: (pending: PendingSelection | null) => void;
  /** The spine's lookup popup. A new selection closes it, and that is the only
   *  thing this hook has to say to it — hence the one-call signature. */
  setLookup: (value: null) => void;
  annotations: Annotation[] | undefined;
  /** Stores a CFI on a highlight that arrived without one. */
  anchorAnnotation: { mutate: (variables: { id: string; cfi: string }) => void };
}

export interface FoliateBook {
  /** The book's own table of contents, handed over once the file is open.
   *  foliate sections do not line up with our chapters, so the drawer switches
   *  to this list while reading a mobi. */
  toc: FoliateTocEntry[];
  /** Receives it. Goes straight to the view's `onTocLoaded`. */
  setToc: (entries: FoliateTocEntry[]) => void;
  /** The section on screen, as the book names it. */
  sectionLabel: string;
  /** The section's own page counter; `null` in the scroll layout. */
  page: { page: number; pages: number } | null;
  /** The reader's position in whole-book pages, as foliate numbers them: the
   *  book's own byte domain, fixed for the book, so it does not move with the
   *  section on screen. `null` until foliate has built its table — the
   *  indicator falls back to the section's own counter until then. */
  bookPage: { page: number; pages: number } | null;
  /** The TOC reshaped into the list the drawer reads. */
  tocChapters: (ChapterMeta & { depth?: number })[];
  /** Where the section on screen sits in it, or -1. */
  tocIdx: number;
  /** Whether foliate's own TOC is the one to read at all — sections replace
   *  the imported chapter list, but only when foliate found a TOC. An old
   *  MOBI6 has none. */
  hasToc: boolean;
  /** The view's location report. */
  remember: (location: FoliateLocation) => void;
  /** The view's selection report. */
  select: (selection: FoliateSelection | null) => void;
  /** The view's click on a painted highlight. */
  annotationClick: (cfi: string, x: number, y: number) => void;
  /** The view found a CFI for a highlight that had none. */
  anchor: (id: string, cfi: string) => void;
}

export function useFoliateBook({
  useFoliate,
  chapters,
  setChapterIdx,
  setDisplayProgress,
  setProgress,
  cfiKey,
  setPending,
  setLookup,
  annotations,
  anchorAnnotation,
}: FoliateBookOptions): FoliateBook {
  const [toc, setToc] = useState<FoliateTocEntry[]>([]);
  const [sectionLabel, setSectionLabel] = useState("");
  const [page, setPage] = useState<{ page: number; pages: number } | null>(null);
  const [bookPage, setBookPage] = useState<{ page: number; pages: number } | null>(null);
  // Pending debounce of the position save. A CFI only ever carries the latest
  // one, so a page-turn storm must not queue a write each.
  const saveRef = useRef<number | null>(null);

  const remember = useCallback(
    (location: FoliateLocation) => {
      // foliate reports true whole-book progress; our chapter-index estimate
      // (51 chapters of uneven length) drifts badly on Kindle files.
      setDisplayProgress(location.fraction);
      setSectionLabel(location.label);
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
      setPage(location.page && { page: location.page.current, pages: location.page.total });
      setBookPage(location.bookPage);
      if (location.cfi === "") return;
      const cfi = location.cfi;
      if (saveRef.current !== null) window.clearTimeout(saveRef.current);
      saveRef.current = window.setTimeout(() => {
        // The CFI goes to the database, where it survives a cache clear and
        // travels with the library row; the old parking spot is retired.
        setProgress({ progress: location.fraction, location: cfi });
        localStorage.removeItem(cfiKey);
      }, POSITION_SAVE_DELAY_MS);
    },
    [cfiKey, chapters, setChapterIdx, setDisplayProgress, setProgress],
  );

  /**
   * foliate selection: the view hands back a CFI, the only anchor that survives
   * a section change — the (chapter, offset) pair the prose path stores means
   * nothing here, because foliate's sections are the container's own.
   */
  const select = useCallback(
    (selection: FoliateSelection | null) => {
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
    },
    [setLookup, setPending],
  );

  /** Click on a painted foliate highlight: reopen the pill in remove mode. */
  const annotationClick = useCallback(
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
    [annotations, setPending],
  );

  /**
   * Stores the anchor a foliate-rendered highlight was missing.
   *
   * An import from a Kindle clippings file only knows the text it quotes, so its
   * row lands without a CFI and foliate has nothing to paint. The view finds the
   * text once the section carrying it is on screen and hands the CFI here; the
   * row is the same highlight it was a moment ago, now paintable.
   */
  const anchor = useCallback(
    (id: string, cfi: string) => anchorAnnotation.mutate({ id, cfi }),
    [anchorAnnotation],
  );

  // The drawer reads chapters; a foliate book is driven by its own TOC, so the
  // entries are reshaped into the same shape (with the nesting depth the
  // folding needs). `chars` is zero because a TOC entry has no chapter body to
  // weigh — nothing downstream counts these.
  const tocChapters = useMemo(
    () =>
      toc.map((entry, idx) => ({
        idx,
        title: entry.label,
        chars: 0,
        depth: entry.depth,
      })),
    [toc],
  );
  const tocIdx = useMemo(
    () => toc.findIndex((entry) => entry.label === sectionLabel),
    [toc, sectionLabel],
  );
  const hasToc = useFoliate && toc.length > 0;

  // A pending save is dropped with the view rather than flushed: the timer
  // belongs to this book's reader, and there is no position left to write to
  // once it is gone.
  useEffect(
    () => () => {
      if (saveRef.current !== null) window.clearTimeout(saveRef.current);
    },
    [],
  );

  return {
    toc,
    setToc,
    sectionLabel,
    page,
    bookPage,
    tocChapters,
    tocIdx,
    hasToc,
    remember,
    select,
    annotationClick,
    anchor,
  };
}
