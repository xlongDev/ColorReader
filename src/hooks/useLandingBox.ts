import { useEffect, type RefObject } from "react";

import { rectOf, useBookHandoff, type CoverBox } from "@/stores/book-handoff";

/**
 * Reports a flight's landing box — once, the first frame the destination can be
 * measured.
 *
 * Polled rather than read on mount, because the far end is not laid out in the
 * same commit this element mounts in. Reported *once*, not tracked: every
 * report is a new end value for the flight's transition, and a transition whose
 * target changes restarts its duration. Tracking it every frame meant a scroll
 * re-targeted the flight on each frame the tile moved, so the cover chased the
 * tile up out of the shelf and over the page header (reported, with a
 * screenshot, as the cover "running away upwards"). The destination is
 * stationary while a cover is in the air anyway — `AppShell` drops the page's
 * entrance travel and `BookCard` skips the landing tile's own entrance — so the
 * first reading is also the last one.
 *
 * ponytail: a scroll *during* a flight therefore lands the cover on the slot the
 * tile had when it left. Bounded and over in a few hundred ms. A true shared
 * element would have to be clipped by the scroller, which a `fixed` overlay
 * outside it cannot be.
 *
 * `visible` lets a caller refuse to be the landing pad at all — the shelf uses
 * it for a tile scrolled out of sight, so the flight dissolves rather than
 * aiming at something nobody can see.
 */
export function useLandingBox(
  id: string,
  ref: RefObject<HTMLElement | null>,
  side: "shelf" | "reader",
  visible?: (box: Omit<CoverBox, "radius">) => boolean,
) {
  const land = useBookHandoff((s) => s.land);
  // Only the receiving end reports: the end a flight is leaving from is not a
  // landing pad, and two writers would aim the same transition at two places.
  const landing = useBookHandoff((s) => s.id === id && s.side !== side);

  useEffect(() => {
    if (!landing) return;
    let frame = 0;
    const tick = () => {
      const element = ref.current;
      if (element) {
        const box = rectOf(element);
        if (!visible || visible(box)) {
          land(id, {
            ...box,
            // Read here rather than every frame: the flight wears the corner it
            // left with, so this is the only place a destination's corner is
            // wanted at all.
            radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
          });
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [landing, id, land, ref, visible]);
}
