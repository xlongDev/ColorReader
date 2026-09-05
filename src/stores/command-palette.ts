import { create } from "zustand";

interface CommandPaletteState {
  open: boolean;
  /**
   * Incremented on every open transition. Used as a remount key for the palette
   * body so the query and selection reset without a state-syncing effect.
   */
  session: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPalette = create<CommandPaletteState>((set) => ({
  open: false,
  session: 0,
  setOpen: (open) =>
    set((state) => (open && !state.open ? { open, session: state.session + 1 } : { open })),
  toggle: () =>
    set((state) => (state.open ? { open: false } : { open: true, session: state.session + 1 })),
}));
