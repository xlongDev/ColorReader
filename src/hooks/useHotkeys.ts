import { useEffect } from "react";

import type { Shortcut } from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";

function isMod(event: KeyboardEvent, mod?: boolean): boolean {
  if (!mod) return !event.metaKey && !event.ctrlKey;
  return event.metaKey || event.ctrlKey;
}

function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  if (event.altKey !== !!shortcut.alt) return false;
  if (event.shiftKey !== !!shortcut.shift) return false;
  if (!isMod(event, shortcut.mod)) return false;
  return event.key.toLowerCase() === shortcut.key.toLowerCase();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Wire the command registry's shortcuts to the global keydown stream. */
export function useHotkeys(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      const commands = useCommandStore.getState().commands;
      for (const command of commands) {
        if (!command.shortcut) continue;
        if (command.isEnabled && !command.isEnabled()) continue;
        const hit = command.shortcut.some((s) => matches(event, s));
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
