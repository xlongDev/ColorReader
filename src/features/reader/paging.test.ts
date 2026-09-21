import { describe, expect, it, vi } from "vitest";

import { alignTail, applyPosition, columnPitch, flipPage, type TailPad } from "./paging";

/**
 * Element stub for the paging maths: the scroll properties, plus the tail
 * spacer the column alignment reaches for. A spacer is a real box in a real
 * scroller — while it is displayed it stretches `scrollWidth` on its own — so
 * the stub reports the content's own end only once the spacer is hidden,
 * which is how the alignment reads it.
 */
function scroller(over: {
  clientWidth: number;
  /** The content's own right edge, spacer not counted. */
  contentEnd: number;
  /** The spacer already in the scroller, if any. */
  pad?: TailPad | null;
  clientHeight?: number;
  scrollHeight?: number;
}) {
  const spacer = {
    style: {
      display: "" as string,
      removeProperty: () => {
        spacer.style.display = "";
      },
    },
  };
  return {
    clientWidth: over.clientWidth,
    clientHeight: over.clientHeight ?? 600,
    scrollHeight: over.scrollHeight ?? 600,
    scrollLeft: 0,
    scrollTop: 0,
    get scrollWidth() {
      const pad = over.pad;
      if (!pad || spacer.style.display === "none") return over.contentEnd;
      return Math.max(over.contentEnd, pad.left + pad.width);
    },
    querySelector: (selector: string) =>
      selector === "[data-tail-pad]" && over.pad ? spacer : null,
  } as unknown as HTMLDivElement;
}

describe("columnPitch", () => {
  it("is the full column plus the gutter in single-column mode", () => {
    // content = 1000 - 2*40 = 920; pitch = 920 + 40
    expect(columnPitch(scroller({ clientWidth: 1000, contentEnd: 5000 }), "single", 40)).toBe(960);
  });

  it("halves the content and keeps the middle gutter in a spread", () => {
    // content = 920; col = (920 - 40) / 2 = 440; pitch = 440 + 40
    expect(columnPitch(scroller({ clientWidth: 1000, contentEnd: 5000 }), "double", 40)).toBe(480);
  });
});

describe("applyPosition", () => {
  it("maps the fraction onto vertical scroll range in scroll mode", () => {
    const el = scroller({
      clientWidth: 1000,
      contentEnd: 1000,
      clientHeight: 200,
      scrollHeight: 1200,
    });
    applyPosition(el, 0.25, "scroll", 40);
    expect(el.scrollTop).toBe(250);
  });

  it("snaps to a whole column instead of a raw pixel offset when paged", () => {
    // pitch 960, max = 5000 - 1000 = 4000 → 4 columns; 0.5 should land on 2
    const el = scroller({ clientWidth: 1000, contentEnd: 5000 });
    applyPosition(el, 0.5, "single", 40);
    expect(el.scrollLeft).toBe(1920);
  });

  it("never scrolls past the end when the fraction overshoots", () => {
    const el = scroller({ clientWidth: 1000, contentEnd: 5000 });
    applyPosition(el, 1, "single", 40);
    expect(el.scrollLeft).toBeLessThanOrEqual(4000);
  });
});

/** Stand-in for the ref `alignTail` keeps its last measurement in. */
const padRef = () => ({ current: null as TailPad | null });

/** Element stub for the transitions, which only ever call these two. */
const animated = () =>
  ({
    scrollTo: vi.fn(),
    animate: vi.fn(),
  }) as unknown as HTMLElement;

describe("alignTail", () => {
  it("drops any pad in scroll mode", () => {
    const el = scroller({ clientWidth: 1000, contentEnd: 5000 });
    const r = { current: { left: 5000, width: 120 } as TailPad | null };
    const set = vi.fn();
    alignTail(el, "scroll", 40, r, set);
    expect(r.current).toBeNull();
    expect(set).toHaveBeenCalledWith(null);
  });

  it("extends the scroll range to the next column boundary", () => {
    // contentEnd 5000, max 4000, pitch 960 → 4000 % 960 = 160 → pad 800
    const el = scroller({ clientWidth: 1000, contentEnd: 5000 });
    const set = vi.fn<(p: TailPad | null) => void>();
    alignTail(el, "single", 40, padRef(), set);
    expect(set).toHaveBeenCalledWith({ left: 5000, width: 800 });
  });

  it("is idempotent once the pad is in place", () => {
    const pad = { left: 5000, width: 800 };
    const el = scroller({ clientWidth: 1000, contentEnd: 5000, pad });
    const r = { current: pad as TailPad | null };
    const set = vi.fn<(p: TailPad | null) => void>();
    alignTail(el, "single", 40, r, set);
    expect(set).not.toHaveBeenCalled();
  });

  it("drops a pad the chapter underneath it has outgrown", () => {
    // The reader moved to a one-page chapter. The spacer still sits at the end
    // of the chapter that left, holding the scroller that wide, so reading the
    // range through it pages the new chapter the length of the old one.
    const el = scroller({
      clientWidth: 1000,
      contentEnd: 1000,
      pad: { left: 5000, width: 800 },
    });
    const r = { current: { left: 5000, width: 800 } as TailPad | null };
    const set = vi.fn<(p: TailPad | null) => void>();
    alignTail(el, "single", 40, r, set);
    expect(r.current).toBeNull();
    expect(set).toHaveBeenCalledWith(null);
  });
});

describe("flipPage", () => {
  it("smooth-scrolls and skips the animation when motion is reduced", () => {
    const node = animated();
    flipPage(node, 960, "fade", 1, true);
    expect(node.scrollTo).toHaveBeenCalledWith({ left: 960, behavior: "smooth" });
    expect(node.animate).not.toHaveBeenCalled();
  });

  it("jumps instantly with no animation for the none transition", () => {
    const node = animated();
    flipPage(node, 960, "none", 1, false);
    expect(node.scrollTo).toHaveBeenCalledWith({ left: 960, behavior: "auto" });
    expect(node.animate).not.toHaveBeenCalled();
  });

  it("animates a fade in over the jump", () => {
    const node = animated();
    flipPage(node, 960, "fade", 1, false);
    expect(node.scrollTo).toHaveBeenCalledWith({ left: 960, behavior: "auto" });
    expect(node.animate).toHaveBeenCalledWith(
      [{ opacity: 0 }, { opacity: 1 }],
      expect.objectContaining({ duration: 300 }),
    );
  });

  it("slides the incoming page in over the page it replaces", () => {
    const node = animated();
    flipPage(node, 960, "slide", 1, false);
    expect(node.scrollTo).toHaveBeenCalledWith({ left: 960, behavior: "auto" });
    // A forward turn arrives from the right; a backward one from the left.
    expect(node.animate).toHaveBeenCalledWith(
      [{ transform: "translateX(100%)" }, { transform: "none" }],
      expect.objectContaining({ duration: 450 }),
    );
    flipPage(node, 0, "slide", -1, false);
    expect(node.animate).toHaveBeenLastCalledWith(
      [{ transform: "translateX(-100%)" }, { transform: "none" }],
      expect.objectContaining({ duration: 450 }),
    );
  });

  it("keeps the native smooth scroll for the pan transition", () => {
    const node = animated();
    flipPage(node, 960, "pan", 1, false);
    expect(node.scrollTo).toHaveBeenCalledWith({ left: 960, behavior: "smooth" });
    expect(node.animate).not.toHaveBeenCalled();
  });

  it.each(["paper", "flip"] as const)(
    "swings the incoming page about the spine for the %s transition",
    (mode) => {
      const node = animated();
      flipPage(node, 960, mode, 1, false);
      const frames = (node.animate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Keyframe[];
      // A forward turn hinges on the left edge, and swings in from -10deg.
      expect(frames[0]!.transformOrigin).toBe("left center");
      expect(String(frames[0]!.transform)).toContain("rotateY(-10deg)");
      expect(node.animate).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ duration: 400 }),
      );
    },
  );
});
