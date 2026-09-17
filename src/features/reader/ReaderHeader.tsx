import { useRef, type RefObject } from "react";
import { BookOpen } from "@phosphor-icons/react";
import { motion } from "motion/react";

import { useBookHandoff } from "@/stores/book-handoff";
import { useLandingBox } from "@/hooks/useLandingBox";
import { useMotion } from "@/lib/motion";

/** Hairline between the header's functional clusters — 导航 / AI / 排版 / 页.
 *  Nine same-weight glass buttons otherwise read as one undifferentiated row. */
export function HeaderRule() {
  return <span aria-hidden className="bg-hairline mx-0.5 h-5 w-px shrink-0" />;
}

/**
 * The book's cover, in the reader's header.
 *
 * It is the landing pad for the cover the shelf sent over (`BookCoverFlight`),
 * so it registers its own box with the handoff and holds itself invisible until
 * the flight arrives. For that one frame the two are the same picture at the
 * same coordinates, which is what makes the handoff read as one object moving
 * rather than two images cross-fading.
 */
export function HeaderCover({
  bookId,
  coverUrl,
  boxRef,
}: {
  bookId: string;
  coverUrl: string | null;
  /** The caller keeps this: leaving the reader flies the cover home from here,
   *  so the box has to be readable from outside the header. */
  boxRef?: RefObject<HTMLSpanElement | null>;
}) {
  const own = useRef<HTMLSpanElement>(null);
  const ref = boxRef ?? own;
  const flying = useBookHandoff((s) => s.id === bookId);
  const m = useMotion();

  // Followed for as long as the cover is in the air: the reader's own entrance
  // is still sliding this header up when the flight claims it, so a box taken
  // once would be ten pixels low (see `useLandingBox`).
  useLandingBox(bookId, ref, "reader");

  return (
    <motion.span
      ref={ref}
      data-header-cover
      animate={{ opacity: flying && !m.reduce ? 0 : 1 }}
      // Both ways instant, and neither is visible on its own: the flight is
      // exactly on top of this thumbnail when it takes the cover away and when
      // it puts it back. Easing it back in is what made the arrival read as a
      // redraw — the flight was still solid at that box, so the two faded
      // through each other instead of handing over.
      transition={{ duration: 0 }}
      // Cornered to the shelf tile's ratio — 18px on its 138px cover, ~13% of
      // the width — not to the panel scale. At 27px wide the panel's 14px is
      // past half the box, so the CSS clamp takes over and the thumbnail paints
      // as a *capsule*: not a value anyone chose, a different shape from every
      // other cover, and one the flight cannot hold at both ends at once.
      className="border-hairline shadow-glass relative block aspect-[3/4] h-9 shrink-0 overflow-hidden rounded-[3.5px] border"
    >
      {coverUrl ? (
        <img src={coverUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <span className="bg-surface-1 text-text-3 flex h-full w-full items-center justify-center">
          <BookOpen size={13} weight="duotone" />
        </span>
      )}
    </motion.span>
  );
}
