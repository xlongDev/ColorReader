import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoliateLocation, FoliateSelection } from "@/features/reader/FoliateBookView";
import { POSITION_SAVE_DELAY_MS } from "@/features/reader/progress";
import { useFoliateBook, type FoliateBookOptions } from "@/features/reader/useFoliateBook";
import type { Annotation, ChapterMeta } from "@/types/ipc";

/**
 * The book as foliate reports it.
 *
 * None of it can be derived from our own chapter list — foliate's sections are
 * the container's own spine items — so the position, the TOC and every anchor
 * come from the view. Each test is one of the promises that translation makes,
 * and two of them fail silently: a location report that misses the spine leaves
 * the AI drawer and the remaining-time labels quoting a chapter the reader has
 * left, and a pill built without the CFI saves a highlight foliate can never
 * paint again.
 */

const CFI_KEY = "colorreader:foliate:book-1";

/** Three chapters of 100 characters each, so a whole-book fraction of 0.5 lands
 *  on the second one and the mapping can be checked by hand. */
const CHAPTERS: ChapterMeta[] = [
  { idx: 0, title: "第一章", chars: 100 },
  { idx: 1, title: "第二章", chars: 100 },
  { idx: 2, title: "第三章", chars: 100 },
];

const location = (over: Partial<FoliateLocation> = {}): FoliateLocation => ({
  cfi: "epubcfi(/6/4!/4/2)",
  fraction: 0.5,
  label: "第二章",
  page: { current: 3, total: 12 },
  bookPage: { page: 40, pages: 300 },
  ...over,
});

const selection = (over: Partial<FoliateSelection> = {}): FoliateSelection => ({
  cfi: "epubcfi(/6/8!/4/2)",
  text: "一段被选中的话",
  section: 7,
  startChar: 12,
  endChar: 20,
  x: 100,
  y: 200,
  bottom: 220,
  ...over,
});

const annotation = (over: Partial<Annotation> = {}): Annotation => ({
  id: "a1",
  bookId: "book-1",
  chapterIdx: 7,
  startChar: 12,
  endChar: 20,
  text: "一段被选中的话",
  cfi: "epubcfi(/6/8!/4/2)",
  color: null,
  style: null,
  note: null,
  createdAt: 0,
  ...over,
});

function setup(overrides: Partial<FoliateBookOptions> = {}) {
  const options: FoliateBookOptions = {
    useFoliate: true,
    chapters: CHAPTERS,
    setChapterIdx: vi.fn(),
    setDisplayProgress: vi.fn(),
    setProgress: vi.fn(),
    cfiKey: CFI_KEY,
    setPending: vi.fn(),
    setLookup: vi.fn(),
    annotations: [],
    anchorAnnotation: { mutate: vi.fn() },
    ...overrides,
  };
  const view = renderHook((props: FoliateBookOptions) => useFoliateBook(props), {
    initialProps: options,
  });
  return { ...view, options };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFoliateBook", () => {
  it("lands foliate's whole-book fraction on one of our chapters", () => {
    const { result, options } = setup();

    act(() => result.current.remember(location({ fraction: 0.5 })));

    // foliate's fraction is the honest position — our own chapter-index
    // estimate drifts badly on a Kindle file — so it drives the spine too, not
    // just this hook's own state.
    expect(options.setDisplayProgress).toHaveBeenCalledWith(0.5);
    expect(options.setChapterIdx).toHaveBeenCalledWith(1);
    expect(result.current.sectionLabel).toBe("第二章");
    expect(result.current.page).toEqual({ page: 3, pages: 12 });
    expect(result.current.bookPage).toEqual({ page: 40, pages: 300 });
  });

  it("clears the section counter when the layout has none", () => {
    const { result } = setup();

    act(() => result.current.remember(location()));
    expect(result.current.page).not.toBeNull();

    // The scroll layout reports no page of its own, and the indicator reads
    // that as "nothing to show" rather than as the last page the paginator saw.
    act(() => result.current.remember(location({ page: null })));
    expect(result.current.page).toBeNull();
  });

  it("writes the position once for a burst of reports, and retires the old slot", () => {
    const { result, options } = setup();
    localStorage.setItem(CFI_KEY, "epubcfi(/6/2!/4/2)");

    // A page-turn storm reports every frame; a CFI only ever carries the
    // latest one, so a write per report would be a write per frame.
    act(() => {
      result.current.remember(location({ cfi: "epubcfi(/6/4!/4/2)", fraction: 0.2 }));
      result.current.remember(location({ cfi: "epubcfi(/6/6!/4/2)", fraction: 0.3 }));
      result.current.remember(location({ cfi: "epubcfi(/6/8!/4/2)", fraction: 0.4 }));
    });
    expect(options.setProgress).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS));

    expect(options.setProgress).toHaveBeenCalledTimes(1);
    expect(options.setProgress).toHaveBeenCalledWith({
      progress: 0.4,
      location: "epubcfi(/6/8!/4/2)",
    });
    // The CFI lives in the database now, where it survives a cache clear and
    // travels with the library row; the localStorage slot is retired.
    expect(localStorage.getItem(CFI_KEY)).toBeNull();
  });

  it("does not write a position when the report carries no CFI", () => {
    const { result, options } = setup();

    act(() => result.current.remember(location({ cfi: "" })));
    act(() => void vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS));

    // Writing `""` would erase the anchor the book resumes from — the report
    // has nothing to say about the position, not "the position is nowhere".
    expect(options.setProgress).not.toHaveBeenCalled();
    // The rest of the report still landed.
    expect(result.current.sectionLabel).toBe("第二章");
  });

  it("drops a pending save with the view", () => {
    const { result, options, unmount } = setup();

    act(() => result.current.remember(location()));
    unmount();
    act(() => void vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS));

    expect(options.setProgress).not.toHaveBeenCalled();
  });

  it("turns a foliate selection into a pill anchored by its CFI", () => {
    const { result, options } = setup();

    act(() => result.current.select(selection()));

    // The lookup popup closes first: one floating surface at a time.
    expect(options.setLookup).toHaveBeenCalledWith(null);
    expect(options.setPending).toHaveBeenCalledWith({
      range: { start: 12, end: 20, text: "一段被选中的话" },
      x: 100,
      y: 200,
      bottom: 220,
      chapterIdx: 7,
      cfi: "epubcfi(/6/8!/4/2)",
    });
  });

  it("clears the pill when the reader collapses the selection", () => {
    const { result, options } = setup();

    act(() => result.current.select(null));

    expect(options.setPending).toHaveBeenCalledWith(null);
    expect(options.setLookup).toHaveBeenCalledWith(null);
  });

  it("reopens a painted highlight in edit mode", () => {
    const stored = annotation({ id: "a7", chapterIdx: 3 });
    const { result, options } = setup({ annotations: [stored] });

    act(() => result.current.annotationClick("epubcfi(/6/8!/4/2)", 55, 66));

    expect(options.setPending).toHaveBeenCalledWith({
      range: { start: 12, end: 20, text: "一段被选中的话" },
      x: 55,
      y: 66,
      annotationId: "a7",
      chapterIdx: 3,
      cfi: "epubcfi(/6/8!/4/2)",
    });
  });

  it("leaves the pill alone when a click misses every highlight", () => {
    const { result, options } = setup({ annotations: [annotation()] });

    act(() => result.current.annotationClick("epubcfi(/6/2!/4/2)", 55, 66));

    // A click that lands on nothing is not "the reader left the pill": closing
    // it here is how a stray tap dismisses a toolbar the reader is using.
    expect(options.setPending).not.toHaveBeenCalled();
  });

  it("stores the CFI the view found for a highlight that had none", () => {
    const { result, options } = setup();

    act(() => result.current.anchor("a7", "epubcfi(/6/8!/4/2)"));

    expect(options.anchorAnnotation.mutate).toHaveBeenCalledWith({
      id: "a7",
      cfi: "epubcfi(/6/8!/4/2)",
    });
  });

  it("reshapes the book's own TOC into the list the drawer reads", () => {
    const { result } = setup();
    expect(result.current.hasToc).toBe(false);

    act(() =>
      result.current.setToc([
        { label: "第一部", href: "part1.xhtml", depth: 0 },
        { label: "第二章", href: "ch2.xhtml", depth: 1 },
      ]),
    );

    expect(result.current.hasToc).toBe(true);
    // The same shape as the imported chapter list, plus the depth the folding
    // needs — and no chapter body to weigh, so nothing downstream counts these.
    expect(result.current.tocChapters).toEqual([
      { idx: 0, title: "第一部", chars: 0, depth: 0 },
      { idx: 1, title: "第二章", chars: 0, depth: 1 },
    ]);
    // Nothing is marked as being read until a location names a section.
    expect(result.current.tocIdx).toBe(-1);

    act(() => result.current.remember(location({ label: "第二章" })));
    expect(result.current.tocIdx).toBe(1);
  });

  it("has no foliate TOC to read in a book that does not render through it", () => {
    const { result } = setup({ useFoliate: false });

    act(() => result.current.setToc([{ label: "第一部", href: "p.xhtml", depth: 0 }]));

    // A prose book has a chapter list, but it is ours — and an old MOBI6 has no
    // TOC at all. Either way the drawer keeps reading the imported list.
    expect(result.current.hasToc).toBe(false);
  });
});
