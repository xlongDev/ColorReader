import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "@/lib/cn";
import { EASE_OUT } from "@/lib/motion";

/**
 * Crossfades between states of one small glyph — a speaker becoming a pause,
 * an arrow becoming a pause — instead of snapping. `state` is only an identity:
 * change it and the old glyph pops out while the new one pops in.
 *
 * For dense rows whose press is the CSS `press` utility this is the animated
 * half the utility cannot express (it owns `transition-property` outright).
 */
export function IconSwap({
  state,
  className,
  children,
}: {
  state: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={state}
        className={cn("grid place-items-center", className)}
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.6 }}
        transition={{ duration: 0.15, ease: EASE_OUT }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}
