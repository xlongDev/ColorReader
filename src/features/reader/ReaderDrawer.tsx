import type { ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";

import { OverlayPortal } from "@/components/glass/overlay";
import { DURATION, SPRING } from "@/lib/motion";

/** Right-hand drawer over a dimmed backdrop shared by every reader panel.
 * The backdrop click and the ✕ both dismiss; motion slides the sheet in from
 * the right edge and back out on close, gated by reduced motion. */
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
  return (
    <OverlayPortal>
      <aside className="fixed inset-0 z-40">
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
                className="text-text-3 hover:text-text-1 transition-colors"
              >
                <X size={15} />
              </button>
            </div>
            {children}
          </div>
        </motion.div>
      </aside>
    </OverlayPortal>
  );
}
