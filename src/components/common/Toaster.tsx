import { AnimatePresence, motion } from "motion/react";
import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";
import { useToasts, type ToastTone } from "@/stores/toasts";

const TONE: Record<ToastTone, { icon: typeof X; accent: string }> = {
  error: { icon: WarningCircle, accent: "text-danger" },
  success: { icon: CheckCircle, accent: "text-success" },
};

/**
 * Failure and confirmation messages, bottom-right.
 *
 * Rendered beside the router rather than inside a page: the shell's panes are
 * `backdrop-filter` elements, which become the containing block for `fixed`
 * children and clip them at the pane's edge.
 */
export function Toaster() {
  const toasts = useToasts((state) => state.toasts);
  const m = useMotion();

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2"
      data-toaster
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const { icon: Icon, accent } = TONE[toast.tone];
          return (
            <motion.div
              key={toast.id}
              layout={!m.reduce}
              initial={{ opacity: 0, y: m.rise, scale: m.reduce ? 1 : 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: m.reduce ? 0 : 4, scale: m.reduce ? 1 : 0.98 }}
              transition={m.enter}
              role={toast.tone === "error" ? "alert" : "status"}
              aria-live={toast.tone === "error" ? "assertive" : "polite"}
              className="glass-2 border-hairline shadow-panel pointer-events-auto flex items-start gap-2.5 rounded-lg p-3"
            >
              <Icon size={18} className={cn("mt-px shrink-0", accent)} aria-hidden />
              <p className="text-text-1 flex-1 text-[13px] leading-relaxed break-words">
                {toast.message}
              </p>
              <button
                type="button"
                onClick={() => useToasts.getState().dismiss(toast.id)}
                aria-label="关闭提示"
                className="text-text-3 hover:text-text-1 focus-visible:focus-ring -mt-0.5 -mr-0.5 shrink-0 rounded-md p-1 transition-colors duration-150"
              >
                <X size={14} aria-hidden />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
