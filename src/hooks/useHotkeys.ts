import { useEffect } from "react";

import { effectiveKeys, isEditableTarget, shortcutMatches } from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";
import { useSettings } from "@/stores/settings";

/** Wire the command registry's shortcuts to the global keydown stream.
 *
 *  This is the one place a *global* hotkey is matched. Keys whose meaning
 *  depends on what the reader is showing are not global and do not live here —
 *  they resolve through their own table (`features/reader/readerKeys.ts`).
 *
 *  Rebound keys are read off the settings store per press rather than captured
 *  when the listener binds: the store is the record of what is bound, and a
 *  listener that had to re-bind to hear a change would be a second copy of it.
 */
export function useHotkeys(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      const commands = useCommandStore.getState().commands;
      const overrides = useSettings.getState().keyOverrides;
      for (const command of commands) {
        const keys = effectiveKeys(command.id, command.shortcut, overrides);
        if (!keys || keys.length === 0) continue;
        if (command.isEnabled && !command.isEnabled()) continue;
        const hit = keys.some((s) => shortcutMatches(event, s));
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
