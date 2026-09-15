import { motion } from "motion/react";

import { useMotion } from "@/lib/motion";
import { useBookHandoff, type CoverBox } from "@/stores/book-handoff";

/**
 * The cover carried from the shelf into the reader.
 *
 * A page-level shared element, done as a `fixed` overlay rather than a shared
 * `layoutId`: a layout animation moves its element with a transform and leaves
 * it where it was in the DOM, so the tile's own `overflow: hidden` would slice
 * the cover as it left. This layer sits in the shell, outside every route, so
 * the route cross-fade (which blurs and scales the page it is leaving) does not
 * drag it along either.
 *
 * It renders in the overlay host, so `fixed` means the window.
 */
export function BookCoverFlight() {
  const m = useMotion();
  const id = useBookHandoff((s) => s.id);
  const coverUrl = useBookHandoff((s) => s.coverUrl);
  const from = useBookHandoff((s) => s.from);
  const to = useBookHandoff((s) => s.to);
  const end = useBookHandoff((s) => s.end);

  if (m.reduce || id === null || from === null) return null;

  // Without a landing box the cover still has to leave: a cold route chunk can
  // take longer than the gesture reads as connected, and a book with no cover
  // never registers one. It lifts and dissolves instead of hovering forever.
  const landing: CoverBox = to ?? {
    x: from.x - from.w * 0.08,
    y: from.y - 44,
    w: from.w * 1.16,
    h: from.h * 1.16,
  };

  return (
    <motion.div
      className="shadow-panel pointer-events-none fixed z-[70] overflow-hidden rounded-sm"
      initial={{ left: from.x, top: from.y, width: from.w, height: from.h, opacity: 1 }}
      animate={{ left: landing.x, top: landing.y, width: landing.w, height: landing.h, opacity: 0 }}
      // The travel is the transition; the fade only tidies the last third, so
      // the cover is still solid when it arrives at the header.
      transition={{ ...m.panel, opacity: { delay: 0.24, duration: 0.2, ease: "easeOut" } }}
      onAnimationComplete={end}
    >
      {coverUrl && <img src={coverUrl} alt="" className="h-full w-full object-cover" />}
    </motion.div>
  );
}
