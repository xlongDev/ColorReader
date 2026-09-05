import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/cn";

interface GlassSidebarProps {
  children: ReactNode;
  className?: string;
  /** Fully collapse to zero width (animated); content is made inert. */
  hidden?: boolean;
}

const COLLAPSED = 76;
const EXPANDED = 248;
const PADDING = 12;
/** The parent flex row reserves a 12px gap; swallow it while collapsed away. */
const ROW_GAP = 12;

/** Floating glass sidebar that smoothly animates between collapsed and expanded. */
export function GlassSidebar({ children, className, hidden = false }: GlassSidebarProps) {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const reduce = useReducedMotion();
  return (
    <motion.aside
      initial={false}
      inert={hidden}
      animate={{
        width: hidden ? 0 : collapsed ? COLLAPSED : EXPANDED,
        opacity: hidden ? 0 : 1,
        padding: hidden ? 0 : PADDING,
        marginLeft: hidden ? -ROW_GAP : 0,
      }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 30 }}
      className={cn(
        "glass-2 shadow-glass shrink-0 self-stretch overflow-hidden rounded-2xl",
        "flex flex-col gap-3",
        className,
      )}
    >
      {children}
    </motion.aside>
  );
}
