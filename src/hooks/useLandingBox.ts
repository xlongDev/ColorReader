import { useEffect, type RefObject } from "react";

import { rectOf, useBookHandoff, type CoverBox } from "@/stores/book-handoff";

/**
 * Keeps a flight's aim on the destination until the flight leaves.
 *
 * Polled rather than read on mount, because the far end is not laid out in the
 * same commit this element mounts in — and re-read until the flight is under
 * way, because the first frame the destination *can* be measured is not the
 * frame it stops moving in. Some of what moves it settles late: the library
 * arriving over IPC and the label line it turns on, a font swapping in, the 续读
 * card above the grid changing book as progress is written. A row's height then
 * moves every row below it, so the error grows down the list — a tile in the
 * last rows ends up tens of pixels from where its cover was aimed, and the
 * handoff snaps the cover onto it, reported as the flight "running down and then
 * up".
 *
 * Updating before the flight leaves is free: the CSS transition has not started,
 * so there is no clock to restart. That is the whole difference between this and
 * the per-frame tracking this hook was cured of — a report *during* the flight
 * re-aimed the transition every frame and made the cover chase a scrolled tile
 * up out of the shelf and over the page header (reported, with a screenshot, as
 * the cover "running away upwards"). `launched` is the line between the two, and
 * it is read from the store inside the loop rather than from the hook's own
 * value, so the loop cannot land one report after the flight has left.
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
  const launched = useBookHandoff((s) => s.launched);

  useEffect(() => {
    if (!landing || launched) return;
    let frame = 0;
    let previous: Omit<CoverBox, "radius"> | null = null;
    const tick = () => {
      const element = ref.current;
      if (element && !useBookHandoff.getState().launched) {
        const box = rectOf(element);
        if (!visible || visible(box)) {
          // Whole pixels: a page settling by fractions of a pixel has not moved,
          // and re-reporting those would restart the launcher's frame — which is
          // what it is waiting on to leave.
          const moved =
            previous === null ||
            Math.round(box.x) !== Math.round(previous.x) ||
            Math.round(box.y) !== Math.round(previous.y) ||
            Math.round(box.w) !== Math.round(previous.w) ||
            Math.round(box.h) !== Math.round(previous.h);
          if (moved) {
            previous = box;
            land(id, {
              ...box,
              // Read here rather than every frame: the flight wears the corner it
              // left with, so this is the only place a destination's corner is
              // wanted at all.
              radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
            });
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [landing, launched, id, land, ref, visible]);
}
