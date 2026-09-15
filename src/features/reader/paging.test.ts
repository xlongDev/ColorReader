import { describe, expect, it, vi } from "vitest";

import { alignTail, applyPosition, columnPitch, flipPage, type TailPad } from "./paging";

/** The only four properties the paging maths reads. */
function scroller(over: {
  clientWidth: number;
  scrollWidth: number;
  clientHeight?: number;
  scrollHeight?: number;
}) {
  return {
    clientWidth: over.clientWidth,
    scrollWidth: over.scrollWidth,
    clientHeight: over.clientHeight ?? 600,
    scrollHeight: over.scrollHeight ?? 600,
    scrollLeft: 0,
    scrollTop: 0,
  } as HTMLDivElement;
}

describe("columnPitch", () => {
  it("is the full column plus the gutter in single-column mode", () => {
    // content = 1000 - 2*40 = 920; pitch = 920 + 40
    expect(columnPitch(scroller({ clientWidth: 1000, scrollWidth: 5000 }), "single", 40)).toBe(960);
  });

  it("halves the content and keeps the middle gutter in a spread", () => {
    // content = 920; col = (920 - 40) / 2 = 440; pitch = 440 + 40
    expect(columnPitch(scroller({ clientWidth: 1000, scrollWidth: 5000 }), "double", 40)).toBe(480);
  });
});

describe("applyPosition", () => {
  it("maps the fraction onto vertical scroll range in scroll mode", () => {
    const el = scroller({
      clientWidth: 1000,
      scrollWidth: 1000,
      clientHeight: 200,
      scrollHeight: 1200,
    });
    applyPosition(el, 0.25, "scroll", 40);
    expect(el.scrollTop).toBe(250);
  });

  it("snaps to a whole column instead of a raw pixel offset when paged", () => {
    // pitch 960, max = 5000 - 1000 = 4000 → 4 columns; 0.5 should land on 2
    const el = scroller({ clientWidth: 1000, scrollWidth: 5000 });
    applyPosition(el, 0.5, "single", 40);
    expect(el.scrollLeft).toBe(1920);
  });

  it("never scrolls past the end when the fraction overshoots", () => {
    const el = scroller({ clientWidth: 1000, scrollWidth: 5000 });
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
    const el = scroller({ clientWidth: 1000, scrollWidth: 5000 });
    const r = { current: { left: 5000, width: 120 } as TailPad | null };
    const set = vi.fn();
    alignTail(el, "scroll", 40, r, set);
    expect(r.current).toBeNull();
    expect(set).toHaveBeenCalledWith(null);
  });

  it("extends the scroll range to the next column boundary", () => {
    // contentEnd 5000, max 4000, pitch 960 → 4000 % 960 = 160 → pad 800
    const el = scroller({ clientWidth: 1000, scrollWidth: 5000 });
    const set = vi.fn<(p: TailPad | null) => void>();
    alignTail(el, "single", 40, padRef(), set);
    expect(set).toHaveBeenCalledWith({ left: 5000, width: 800 });
  });

  it("is idempotent once the pad is in place", () => {
    const el = scroller({ clientWidth: 1000, scrollWidth: 5000 });
    const r = padRef();
    const set = vi.fn<(p: TailPad | null) => void>();
    alignTail(el, "single", 40, r, set);
    const calls = set.mock.calls.length;
    // The pad is now rendered: the scroller really is this much wider.
    const grown = scroller({ clientWidth: 1000, scrollWidth: 5000 + r.current!.width });
    alignTail(grown, "single", 40, r, set);
    expect(set.mock.calls.length).toBe(calls);
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

  it("mirrors the crease axis for the top-right peel", () => {
    const node = animated();
    flipPage(node, 960, "peel-tr", 1, false);
    const frames = (node.animate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Keyframe[];
    expect(String(frames[0]!.transform)).toContain("0.667");
    expect(String(frames[0]!.transform)).toContain("12deg");
  });
});
