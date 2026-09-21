import type { RefObject } from "react";

import type { LayoutMode, PageTransition } from "@/features/reader/theme";

/** A transparent strip that pads the scroll range so the chapter's last page
 * also starts exactly on a column boundary. */
export interface TailPad {
  left: number;
  width: number;
}

/**
 * The curve foliate's layered `slide` turn uses for its VT keyframes
 * (paginator.js `foliate-turn-slide-out-left`). The prose path cannot
 * snapshot the outgoing page, so it slides the incoming one in on the same
 * curve to read as the same gesture.
 */
const SLIDE_EASING = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";

/** Distance between neighbouring column boundaries in a paged layout (px).
 * `margin` is the final applied side margin. */
export function columnPitch(el: HTMLDivElement, mode: LayoutMode, margin: number): number {
  const content = el.clientWidth - margin * 2;
  const colWidth = mode === "double" ? (content - margin) / 2 : content;
  return colWidth + margin;
}

/** Applies a saved fraction along the active axis of the reading viewport. */
export function applyPosition(
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

/**
 * Chapter content rarely spans an exact multiple of the column pitch, so the
 * maximum scroll offset lands mid-column and the last page shows slivers of
 * its neighbours. Extends the scroll range with an absolutely-positioned
 * spacer until the end aligns with the grid.
 */
export function alignTail(
  el: HTMLDivElement,
  mode: LayoutMode,
  margin: number,
  ref: RefObject<TailPad | null>,
  set: (pad: TailPad | null) => void,
): void {
  if (mode === "scroll") {
    if (ref.current !== null) {
      ref.current = null;
      set(null);
    }
    return;
  }
  const pitch = columnPitch(el, mode, margin);
  // Read the content's own end with the spacer out of the layout. The spacer
  // is absolutely positioned, so it stretches `scrollWidth` on its own, and
  // subtracting its width alone leaves it self-perpetuating: a spacer past the
  // content still reports the end the content used to have. That is exactly
  // the state a shorter chapter arrives to — its predecessor's end — and the
  // scroller then stays as wide as the chapter that left, so the new chapter
  // pages out too long and scrolls on into blank space.
  const pad = el.querySelector<HTMLElement>("[data-tail-pad]");
  if (pad) pad.style.display = "none";
  const contentEnd = el.scrollWidth;
  if (pad) pad.style.removeProperty("display");
  const max = contentEnd - el.clientWidth;
  const width = pitch > 0 && max > 0 ? (pitch - (max % pitch)) % pitch : 0;
  const next = width > 0 ? { left: contentEnd, width } : null;
  const prev = ref.current;
  if (next?.width !== prev?.width || next?.left !== prev?.left) {
    ref.current = next;
    set(next);
  }
}

/**
 * Performs one in-chapter page flip, honouring the page-transition setting:
 * "pan" keeps the native smooth scroll (the same clipped horizontal slide the
 * MOBI path uses via foliate's native pan); "slide", "fade", "flip" and
 * "paper" jump to the target page instantly and animate the new page in via
 * WAAPI — imperative, so a flip never re-renders or remounts the chapter — and
 * "none" jumps with no animation. Reduced motion always jumps instantly.
 *
 * There is nothing to snapshot here, so prose cannot tell「翻牌」from「仿真」:
 * both swing the incoming page in about the spine (the foliate path turns the
 * outgoing one). The slide length matches the foliate path's, so one setting
 * reads the same in either renderer.
 */
export function flipPage(
  el: HTMLElement,
  left: number,
  mode: PageTransition,
  dir: 1 | -1,
  /** `null` while motion preference is undetermined; treated as no reduction. */
  reduced: boolean | null,
): void {
  if (reduced || mode === "pan") {
    el.scrollTo({ left, behavior: "smooth" });
    return;
  }
  if (mode === "none") {
    el.scrollTo({ left, behavior: "auto" });
    return;
  }
  el.scrollTo({ left, behavior: "auto" });
  if (mode === "slide") {
    el.animate(
      [{ transform: `translateX(${dir === 1 ? "100%" : "-100%"})` }, { transform: "none" }],
      { duration: 450, easing: SLIDE_EASING },
    );
    return;
  }
  // "fade" cross-dissolves the incoming page; "flip" and "paper" swing it in
  // about the spine.
  const frames: Keyframe[] =
    mode === "fade"
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          {
            opacity: 0,
            transform: `perspective(1200px) rotateY(${dir === 1 ? -10 : 10}deg)`,
            transformOrigin: dir === 1 ? "left center" : "right center",
          },
          { opacity: 1, transform: "perspective(1200px) rotateY(0deg)" },
        ];
  el.animate(frames, {
    duration: mode === "fade" ? 300 : 400,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });
}
