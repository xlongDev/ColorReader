import { create } from "zustand";

import type { Command } from "@/lib/commands";

/** Command Registry: every palette, hotkey and context menu hits this store. */
interface CommandStore {
  commands: Command[];
  register: (entries: readonly Command[]) => void;
  unregister: (ids: readonly string[]) => void;
}

export const useCommandStore = create<CommandStore>((set) => ({
  commands: [],
  register: (entries) =>
    set((state) => {
      const next = state.commands.filter(
        (existing) => !entries.some((entry) => entry.id === existing.id),
      );
      return { commands: [...next, ...entries] };
    }),
  unregister: (ids) =>
    set((state) => ({
      commands: state.commands.filter((entry) => !ids.includes(entry.id)),
    })),
}));
