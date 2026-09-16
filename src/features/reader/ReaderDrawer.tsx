import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";

import { DURATION, SPRING } from "@/lib/motion";

/**
 * The reading viewport, resolved lazily and re-resolved while it is missing —
 * the same shape `overlayHost` uses, and for the same reason: the drawer is
 * declared beside the reader's own tree but has to be *sized* by a box that
 * tree draws.
 */
let viewportEl: HTMLElement | null = null;
function readingViewport(): HTMLElement | null {
  if (!viewportEl?.isConnected) {
    viewportEl = document.querySelector<HTMLElement>("[data-reading-viewport]");
  }
  return viewportEl;
}

/** Right-hand drawer over a dimmed backdrop shared by every reader panel.
 * The backdrop click and the ✕ both dismiss; motion slides the sheet in from
 * the right edge and back out on close, gated by reduced motion.
 *
 * It is bounded by the reading viewport rather than by the window — the box
 * between the header and the footer. Sized to the window it ran the full
 * height of the app and sat over both bars. Anchoring it here also means the
 * page keeps its own width: opening a panel never reflows the book. The
 * read-aloud pill is anchored the same way, for the same reason. */
export function ReaderDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();

  const sheet = (
    // Deliberately *not* `overflow: hidden`. The sheet slides out to
    // `x: 110%`, which does paint past this box for the length of the exit —
    // but that is ink overflow on a `visible` ancestor, nothing scrolls, and
    // the pane clips it anyway. Clipping here instead would turn the aside
    // into a scroll container, and a scroll container is exactly what
    // `scrollIntoView` reaches for: a panel centring its current row used to
    // drag the whole sheet sideways inside this box. It would also shear off
    // the card's own shadow (`0 30px 80px`), which needs more room than the
    // 12px of padding this box leaves it.
    <aside className="absolute inset-0 z-40">
      <motion.button
        type="button"
        aria-label="关闭面板"
        className="absolute inset-0 cursor-default bg-black/25"
        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: reduce ? 0 : DURATION.base }}
        onClick={onClose}
      />
      <motion.div
        className="absolute inset-y-0 right-0 w-80 max-w-[85vw] p-3"
        initial={reduce ? { opacity: 0 } : { x: "110%" }}
        animate={{ x: 0, opacity: 1 }}
        exit={reduce ? { opacity: 0 } : { x: "110%", opacity: 1 }}
        transition={SPRING.panel}
      >
        <div className="glass-solid shadow-panel flex h-full flex-col rounded-2xl">
          <div className="border-hairline flex items-center justify-between border-b px-4 py-3">
            <p className="text-text-1 text-sm font-medium">{title}</p>
            <button
              type="button"
              aria-label={`关闭${title}`}
              onClick={onClose}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 transition-colors"
            >
              <X size={15} />
            </button>
          </div>
          {children}
        </div>
      </motion.div>
    </aside>
  );

  const host = readingViewport();
  return host ? createPortal(sheet, host) : sheet;
}
