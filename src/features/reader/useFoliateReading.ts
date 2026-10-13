import { useCallback, useMemo, useRef, type RefObject } from "react";

import type { FoliateHandle } from "@/features/reader/FoliateBookView";
import type { RulerRect } from "@/features/reader/rulerPointer";
import {
  useFoliateBook,
  type FoliateBook,
  type FoliateBookOptions,
} from "@/features/reader/useFoliateBook";
import type { WritingMode } from "@/features/reader/theme";
import type { Annotation } from "@/types/ipc";

/**
 * Everything the foliate path keeps for itself.
 *
 * A foliate book keeps its own XHTML and CSS, so the book on screen answers
 * questions the other two renderers answer from our own model: where the
 * sections are, where the reader is inside them, and where a followed link's
 * highlight sits. `useFoliateBook` owns the book itself; what is left here is
 * the wiring the page used to hold — the view's imperative handle, the two
 * calls the reading ruler makes into the view, the axis a vertical book reads
 * along, and the CFI the view opens at.
 */
export interface FoliateReadingOptions extends Omit<FoliateBookOptions, "cfiKey"> {
  bookId: string;
  /** The highlight a followed `colorreader://` link names. A link carries an
   *  id, not a position, so the row has to be in hand before anything can be
   *  anchored to it. */
  deepLinkTarget: Annotation | null;
  /** Stored reading anchor for the book (a CFI); `null` for the rest. */
  initialCfi: string | null;
  /** Whether the book's columns run right-to-left, top-to-bottom. */
  writingMode: WritingMode;
}

export interface FoliateReading extends FoliateBook {
  /** The view, driven imperatively (see `flip` / `stepChapter`): paging and
   *  sections never touch our chapter index. */
  ref: RefObject<FoliateHandle | null>;
  /** Drops the match highlights foliate painted into the pages. Stable,
   *  because the panels hook keeps `close` identity-stable for the key
   *  handler's dependency list. */
  clearPaintedMatches: () => void;
  /**
   * The reading ruler's lines, asked of the book rather than read from here:
   * a foliate book's words are in section iframes, and only the view knows
   * where those sections currently sit.
   */
  rulerLines: () => readonly RulerRect[] | null;
  /** Whether the next page lies to the left — a vertical book reads that way. */
  readsLeftward: boolean;
  /**
   * Where the view opens. foliate opens at a CFI or not at all, and a link's
   * CFI only exists once the annotation list has landed — the route holds the
   * reader back until it has, so this is settled by the time the view mounts.
   * A link whose highlight is gone, deleted, or never anchored falls through
   * to the saved position, which is the right degradation: the book still
   * opens.
   */
  startCfi: string | null;
}

export function useFoliateReading({
  bookId,
  deepLinkTarget,
  initialCfi,
  writingMode,
  useFoliate,
  chapters,
  setChapterIdx,
  setDisplayProgress,
  setProgress,
  setPending,
  setLookup,
  annotations,
  anchorAnnotation,
}: FoliateReadingOptions): FoliateReading {
  // A foliate position is a CFI, an opaque string our (chapter, fraction)
  // progress model cannot express. It rides in `books.location`; the
  // localStorage key it used to park in is read once as a fallback and
  // cleared the moment the database has the value.
  const cfiKey = `colorreader:foliate:${bookId}`;
  const startCfi = useMemo(() => {
    if (!useFoliate) return null;
    return deepLinkTarget?.cfi ?? initialCfi ?? localStorage.getItem(cfiKey);
  }, [deepLinkTarget, initialCfi, useFoliate, cfiKey]);

  const book = useFoliateBook({
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
  });

  const ref = useRef<FoliateHandle | null>(null);
  const clearPaintedMatches = useCallback(() => {
    if (useFoliate) ref.current?.clearSearch();
  }, [useFoliate]);
  const rulerLines = useCallback(() => ref.current?.rulerLines() ?? null, []);
  const readsLeftward = useFoliate && writingMode === "vertical";

  return { ...book, ref, clearPaintedMatches, rulerLines, readsLeftward, startCfi };
}
