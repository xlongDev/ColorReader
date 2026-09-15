import type { ReactNode } from "react";
import { motion } from "motion/react";

import { useMotion } from "@/lib/motion";

/**
 * Content arriving once, along the y axis, in the app's vocabulary.
 *
 * For a block that appears on its own — a panel body, an empty state, the
 * first section of a page. Siblings appearing together should each take a
 * `delay` from `staggerDelay(i, m.stagger)` instead, so the group reads as a
 * group rather than one slab; that is why the delay is a plain argument rather
 * than something this component works out for itself.
 */
export function Reveal({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const m = useMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...m.enter, delay }}
    >
      {children}
    </motion.div>
  );
}
