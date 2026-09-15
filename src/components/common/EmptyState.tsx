import type { ReactNode } from "react";
import { motion } from "motion/react";

import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** A quiet, centered empty state used by features that ship in later phases. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  const m = useMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={m.enter}
      className={cn("flex h-full flex-col items-center justify-center px-6 text-center", className)}
    >
      {/* A warm halo behind the glyph, so the state reads as a deliberate
          pause rather than a page that failed to load. */}
      <div className="relative mb-5">
        <span aria-hidden className="bg-accent-soft absolute -inset-5 rounded-full blur-2xl" />
        <span className="glass text-text-2 relative flex h-14 w-14 items-center justify-center rounded-2xl">
          {icon}
        </span>
      </div>
      <h2 className="text-text-1 text-base font-semibold">{title}</h2>
      {description && (
        <p className="text-text-2 mt-1.5 max-w-[42ch] text-[13.5px] leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}
