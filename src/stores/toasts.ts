import { create } from "zustand";

export type ToastTone = "error" | "success";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

/** Long enough to read a sentence, short enough that a stack clears itself. */
const TIMEOUT_MS = 6_000;

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

/**
 * Transient error and success messages.
 *
 * Deliberately a store rather than query state: nothing here comes from the
 * backend, and the read path is the whole app rather than one route.
 */
export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],

  push: (toast) => {
    // A retried save that keeps failing would otherwise stack the same line
    // every few seconds; one copy on screen already says it.
    const shown = get().toasts.some((t) => t.tone === toast.tone && t.message === toast.message);
    if (shown) return;

    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => get().dismiss(id), TIMEOUT_MS);
  },

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** The non-React entry point — the query cache reports failures from outside a component. */
export function showToast(tone: ToastTone, message: string): void {
  useToasts.getState().push({ tone, message });
}
