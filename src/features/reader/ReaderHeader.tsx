import { useEffect, useRef } from "react";
import { BookOpen } from "@phosphor-icons/react";
import { motion } from "motion/react";

import { boxOf, useBookHandoff } from "@/stores/book-handoff";
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
export function HeaderCover({ bookId, coverUrl }: { bookId: string; coverUrl: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const land = useBookHandoff((s) => s.land);
  const flying = useBookHandoff((s) => s.id === bookId);
  const m = useMotion();

  useEffect(() => {
    const element = ref.current;
    if (element) land(bookId, boxOf(element));
  }, [bookId, land]);

  return (
    <motion.span
      ref={ref}
      animate={{ opacity: flying && !m.reduce ? 0 : 1 }}
      // Snap out of sight the moment the flight starts; ease back in when it
      // lands. `flying` is only ever true for a cover already in the air.
      transition={{ duration: flying ? 0 : 0.18 }}
      className="border-hairline shadow-glass relative block aspect-[3/4] h-9 shrink-0 overflow-hidden rounded-sm border"
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
