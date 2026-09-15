import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";

/**
 * The shell's overlay host (see `AppShell`). Resolved lazily and re-resolved
 * while it is missing — a page mounts before the shell's own commit has landed
 * the host, but long before anything needs to portal into it.
 */
let overlayHostEl: HTMLElement | null = null;
export function overlayHost(): HTMLElement | null {
  if (!overlayHostEl?.isConnected) {
    overlayHostEl = document.querySelector<HTMLElement>("[data-overlay-host]");
  }
  return overlayHostEl;
}

/**
 * Renders floating UI into the shell rather than where it is declared.
 *
 * A `backdrop-filter` — the one the glass pane wears for its material — makes
 * its element the containing block for `position: fixed` descendants, and the
 * pane is `overflow: hidden` on top of that. A `fixed` overlay left inside a
 * page is therefore positioned from the pane's own origin instead of the
 * window's (off by the sidebar and the title bar) and then sliced at the
 * pane's edge. The host sits in the shell, where `fixed` means the window
 * again, and it inherits the same `data-theme` and reading-surface tokens the
 * pages do.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  const host = overlayHost();
  return host ? createPortal(children, host) : children;
}

interface GlassDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Tailwind width class, defaults to a comfortable palette width. */
  widthClass?: string;
}

/** Modal surface with Radix focus management and a motion-aware entry. */
export function GlassDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  widthClass = "w-[min(92vw,640px)]",
}: GlassDialogProps) {
  const reduce = useReducedMotion();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="backdrop-glass fixed inset-0 z-50 bg-black/40"
                initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? { opacity: 1 } : { opacity: 0 }}
                transition={{ duration: 0.18 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount>
              <motion.div
                className={cn(
                  "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
                  widthClass,
                  "glass-2 shadow-panel rounded-2xl p-5 outline-none",
                )}
                initial={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 320, damping: 30 }}
              >
                {title && (
                  <Dialog.Title className="text-text-1 mb-1 text-base font-semibold">
                    {title}
                  </Dialog.Title>
                )}
                {description && (
                  <Dialog.Description className="text-text-2 mb-4 text-sm">
                    {description}
                  </Dialog.Description>
                )}
                {children}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
