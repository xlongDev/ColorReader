import { useEffect } from "react";

import { isEditableTarget, shortcutMatches } from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";

/** Wire the command registry's shortcuts to the global keydown stream.
 *
 *  This is the one place a *global* hotkey is matched. Keys whose meaning
 *  depends on what the reader is showing are not global and do not live here —
 *  they resolve through their own table (`features/reader/readerKeys.ts`). */
export function useHotkeys(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      const commands = useCommandStore.getState().commands;
      for (const command of commands) {
        if (!command.shortcut) continue;
        if (command.isEnabled && !command.isEnabled()) continue;
        const hit = command.shortcut.some((s) => shortcutMatches(event, s));
        if (!hit) continue;
        event.preventDefault();
        event.stopPropagation();
        void command.run();
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
