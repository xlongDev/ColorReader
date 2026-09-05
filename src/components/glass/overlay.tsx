import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";

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
