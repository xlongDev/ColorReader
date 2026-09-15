import type { RefObject } from "react";

import type { LayoutMode, PageTransition } from "@/features/reader/theme";

/** A transparent strip that pads the scroll range so the chapter's last page
 * also starts exactly on a column boundary. */
export interface TailPad {
  left: number;
  width: number;
}

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
  // Exclude the currently rendered spacer so the measurement is idempotent.
  const contentEnd = el.scrollWidth - (ref.current?.width ?? 0);
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
 * "slide" and "pan" keep the native smooth scroll (the same clipped horizontal
 * slide the MOBI path uses via foliate's native pan, and the EPUB prose path
 * via `scrollTo`); "fade", "paper" and the two peels jump to the target page
 * instantly and animate the new page in via WAAPI — imperative, so a flip never
 * re-renders or remounts the chapter — and "none" jumps with no animation.
 * Reduced motion always jumps instantly.
 */
export function flipPage(
  el: HTMLElement,
  left: number,
  mode: PageTransition,
  dir: 1 | -1,
  /** `null` while motion preference is undetermined; treated as no reduction. */
  reduced: boolean | null,
): void {
  if (reduced || mode === "slide" || mode === "pan") {
    el.scrollTo({ left, behavior: "smooth" });
    return;
  }
  if (mode === "none") {
    el.scrollTo({ left, behavior: "auto" });
    return;
  }
  el.scrollTo({ left, behavior: "auto" });
  // The prose path animates the incoming page, so the peel is mirrored: the
  // page settles out of the crease fold instead of folding away. `grabTop`
  // mirrors the crease axis for the top-right variant.
  const grabTop = mode === "peel-tr";
  const axis = grabTop ? "0.667" : "-0.667";
  const frames: Keyframe[] =
    mode === "fade"
      ? [{ opacity: 0 }, { opacity: 1 }]
      : mode === "peel-br" || mode === "peel-tr"
        ? [
            {
              opacity: 0,
              transform: `perspective(1400px) translate3d(6%, ${grabTop ? "-6" : "6"}%, 0) rotate3d(1, ${axis}, 0, ${grabTop ? "12" : "-12"}deg)`,
            },
            {
              opacity: 1,
              transform: `perspective(1400px) translate3d(0, 0, 0) rotate3d(1, ${axis}, 0, 0deg)`,
            },
          ]
        : [
            {
              opacity: 0,
              transform: `perspective(1200px) rotateY(${dir === 1 ? -10 : 10}deg)`,
              transformOrigin: dir === 1 ? "left center" : "right center",
            },
            { opacity: 1, transform: "perspective(1200px) rotateY(0deg)" },
          ];
  const duration = mode === "paper" ? 400 : mode === "peel-br" || mode === "peel-tr" ? 420 : 300;
  el.animate(frames, { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
}
