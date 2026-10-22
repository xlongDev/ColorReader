import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useFoliateReading, type FoliateReadingOptions } from "@/features/reader/useFoliateReading";
import type { Annotation, ChapterMeta } from "@/types/ipc";

/**
 * The wiring the page used to hold around a foliate book.
 *
 * The one promise here that fails silently is the CFI the view opens at:
 * foliate opens at a CFI or not at all, and a wrong answer sends the reader to
 * the book's first page with nothing on screen to say so. A followed
 * `fangce://` link's CFI wins (it names where the reader asked to go),
 * then the saved position, then the key a book parked in localStorage before
 * the database had a column for it — and a non-foliate book never reads any of
 * them.
 */

const CFI_KEY = "fangce:foliate:book-1";

const CHAPTERS: ChapterMeta[] = [
  { idx: 0, title: "第一章", chars: 100 },
  { idx: 1, title: "第二章", chars: 100 },
];

function annotation(cfi: string | null): Annotation {
  return {
    id: "a1",
    bookId: "b1",
    chapterIdx: 1,
    startChar: 4,
    endChar: 9,
    text: "被链接的话",
    cfi,
    color: null,
    style: null,
    note: null,
    createdAt: 0,
  };
}

function options(over: Partial<FoliateReadingOptions> = {}): FoliateReadingOptions {
  return {
    bookId: "book-1",
    deepLinkTarget: null,
    initialCfi: null,
    writingMode: "horizontal",
    useFoliate: true,
    chapters: CHAPTERS,
    setChapterIdx: () => {},
    setDisplayProgress: () => {},
    setProgress: () => {},
    setPending: () => {},
    setLookup: () => {},
    annotations: [],
    anchorAnnotation: { mutate: () => {} },
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("useFoliateReading", () => {
  it("opens at the CFI a followed link names", () => {
    const { result } = renderHook(() =>
      useFoliateReading(
        options({
          deepLinkTarget: annotation("epubcfi(/6/8!/4/2)"),
          initialCfi: "epubcfi(/6/4!/4/2)",
        }),
      ),
    );

    expect(result.current.startCfi).toBe("epubcfi(/6/8!/4/2)");
  });

  it("falls back to the saved position, then to the retired localStorage key", () => {
    const saved = renderHook(() =>
      useFoliateReading(options({ initialCfi: "epubcfi(/6/4!/4/2)" })),
    );
    expect(saved.result.current.startCfi).toBe("epubcfi(/6/4!/4/2)");

    localStorage.setItem(CFI_KEY, "epubcfi(/6/6!/4/2)");
    const parked = renderHook(() => useFoliateReading(options()));
    expect(parked.result.current.startCfi).toBe("epubcfi(/6/6!/4/2)");
  });

  it("asks nothing of a book that is not foliate's", () => {
    localStorage.setItem(CFI_KEY, "epubcfi(/6/6!/4/2)");
    const { result } = renderHook(() =>
      useFoliateReading(options({ useFoliate: false, initialCfi: "epubcfi(/6/4!/4/2)" })),
    );

    expect(result.current.startCfi).toBeNull();
  });

  it("reads right-to-left only for a vertical book", () => {
    const vertical = renderHook(() => useFoliateReading(options({ writingMode: "vertical" })));
    const horizontal = renderHook(() => useFoliateReading(options()));

    expect(vertical.result.current.readsLeftward).toBe(true);
    expect(horizontal.result.current.readsLeftward).toBe(false);
  });

  it("asks the view for the ruler's lines, and clears what search painted", () => {
    let cleared = false;
    const { result } = renderHook(() => {
      const reading = useFoliateReading(options());
      (reading.ref as { current: unknown }).current = {
        rulerLines: () => [{ x: 12, y: 40, width: 200, height: 18 }],
        clearSearch: () => {
          cleared = true;
        },
      };
      return reading;
    });

    // Both calls reach the view rather than a cached copy of it: a page the
    // reader has already turned to answers from where its sections now sit,
    // and the panel's close has to drop the highlights foliate painted in.
    expect(result.current.rulerLines()).toEqual([{ x: 12, y: 40, width: 200, height: 18 }]);
    result.current.clearPaintedMatches();
    expect(cleared).toBe(true);
  });
});
