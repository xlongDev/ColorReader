import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHitJumps, type HitJumpsOptions } from "@/hooks/useHitJumps";
import type { RagHit, SearchHit } from "@/types/ipc";

/**
 * The rule these three callbacks share, and the only reason they are one thing
 * rather than three: a position in the chapter on screen can be scrolled to
 * now, one in another chapter has to wait for that chapter to render, and one
 * in another book is not a jump at all. Each case is a promise about which
 * slot gets written — and writing the wrong one is how "jump to hit" ends up
 * scrolling a chapter that has not been fetched yet.
 */
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

/** Three paragraphs of three characters: offsets 0–3 land in the first,
 *  4–7 in the second, 8–11 in the third (see `paragraphAt`). */
const PARAGRAPHS = ["aaa", "bbb", "ccc"];

let scrolls: { selector: string; into: ReturnType<typeof vi.fn> }[] = [];

beforeEach(() => {
  scrolls = [];
  navigate.mockClear();
});

/** A scroller that records what was asked of it instead of laying anything
 *  out: jsdom has no `scrollIntoView`, and the selector is the assertion. */
function fakeScroller() {
  return {
    current: {
      querySelector: (selector: string) => {
        const into = vi.fn();
        scrolls.push({ selector, into });
        return { scrollIntoView: into };
      },
    } as unknown as HTMLDivElement,
  };
}

function setup(overrides: Partial<HitJumpsOptions> = {}) {
  const options: HitJumpsOptions = {
    bookId: "book-1",
    chapterIdx: 1,
    paragraphs: PARAGRAPHS,
    goTo: vi.fn(),
    setPendingFocus: vi.fn(),
    scrollRef: fakeScroller() as HitJumpsOptions["scrollRef"],
    ...overrides,
  };
  const view = renderHook((props: HitJumpsOptions) => useHitJumps(props), {
    initialProps: options,
  });
  return { ...view, options };
}

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  bookId: "book-1",
  bookTitle: "书",
  chapterIdx: 1,
  chapterTitle: "一",
  snippet: "…",
  offset: 4,
  ...over,
});

const citation = (over: Partial<RagHit> = {}): RagHit => ({
  bookId: "book-1",
  bookTitle: "书",
  chapterIdx: 1,
  startChar: 4,
  score: null,
  text: "…",
  ...over,
});

describe("useHitJumps", () => {
  it("scrolls to a hit in the chapter already on screen", () => {
    const { result, options } = setup();

    act(() => result.current.pick(hit({ chapterIdx: 1, offset: 4 })));

    // The paragraph holding offset 4 is the second one.
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]?.selector).toBe('[data-para-idx="1"]');
    expect(scrolls[0]?.into).toHaveBeenCalledWith({ block: "center" });
    // Nothing was parked and the reader did not move: there was nothing to
    // wait for.
    expect(options.goTo).not.toHaveBeenCalled();
    expect(options.setPendingFocus).not.toHaveBeenCalled();
  });

  it("parks a hit in another chapter and waits for it to render", () => {
    const { result, options } = setup();

    act(() => result.current.pick(hit({ chapterIdx: 2, offset: 4 })));

    expect(options.setPendingFocus).toHaveBeenCalledWith(4);
    expect(options.goTo).toHaveBeenCalledWith(2);
    // Scrolling now would target the chapter that is still on screen.
    expect(scrolls).toHaveLength(0);
  });

  it("scrolls to a citation in this book, in the chapter on screen", () => {
    const { result, options } = setup();

    act(() => result.current.follow(citation({ chapterIdx: 1, startChar: 2 })));

    expect(scrolls[0]?.selector).toBe('[data-para-idx="0"]');
    expect(options.goTo).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("parks a citation in another chapter of this book", () => {
    const { result, options } = setup();

    act(() => result.current.follow(citation({ chapterIdx: 2, startChar: 8 })));

    expect(options.setPendingFocus).toHaveBeenCalledWith(8);
    expect(options.goTo).toHaveBeenCalledWith(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  /** A citation into another book is a navigation, not a jump: this reader has
   *  neither the chapter nor the library row for it. */
  it("opens another book for a citation that names one", () => {
    const { result, options } = setup();

    act(() => result.current.follow(citation({ bookId: "book-2", chapterIdx: 3, startChar: 9 })));

    expect(navigate).toHaveBeenCalledWith("/reader?book=book-2&chapter=3&at=9");
    expect(options.goTo).not.toHaveBeenCalled();
    expect(options.setPendingFocus).not.toHaveBeenCalled();
    expect(scrolls).toHaveLength(0);
  });

  it("does nothing when the chapter body is not on screen yet", () => {
    const { result, options } = setup({ paragraphs: undefined });

    act(() => result.current.pick(hit({ chapterIdx: 1, offset: 4 })));

    expect(scrolls).toHaveLength(0);
    expect(options.goTo).not.toHaveBeenCalled();
  });

  it("does nothing when there is no scroller to move", () => {
    const { result, options } = setup({
      scrollRef: { current: null } as HitJumpsOptions["scrollRef"],
    });

    act(() => result.current.pick(hit({ chapterIdx: 1, offset: 4 })));

    expect(scrolls).toHaveLength(0);
    expect(options.goTo).not.toHaveBeenCalled();
  });
});
