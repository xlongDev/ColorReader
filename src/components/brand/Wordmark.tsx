import { motion } from "motion/react";

interface WordmarkProps {
  /** When the sidebar is collapsed, only the spectrum is shown. */
  compact?: boolean;
}

/** The ColorReader mark: a five-bar muted spectrum over the wordmark. */
export function Wordmark({ compact = false }: WordmarkProps) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
        <rect x="2" y="4" width="18" height="2.4" rx="1.2" fill="#F0A93B" />
        <rect x="2" y="8.2" width="18" height="2.4" rx="1.2" fill="#E0735C" />
        <rect x="2" y="12.4" width="18" height="2.4" rx="1.2" fill="#B0679B" />
        <rect x="2" y="16.6" width="18" height="2.4" rx="1.2" fill="#5C7FBF" />
        <rect x="2" y="16.6" width="10" height="2.4" rx="1.2" fill="#4FA89B" />
      </svg>
      {/* Stays in layout and fades instead of unmounting: collapsing fades it
          out before the shell clips it, expanding fades it back in after the
          pane has mostly opened. */}
      <motion.span
        initial={false}
        animate={{ opacity: compact ? 0 : 1 }}
        transition={{ duration: compact ? 0.1 : 0.18, delay: compact ? 0 : 0.15 }}
        className="text-text-1 text-[15px] font-semibold tracking-tight whitespace-nowrap"
      >
        ColorReader
      </motion.span>
    </div>
  );
}
