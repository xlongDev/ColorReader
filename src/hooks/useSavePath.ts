import { useCallback, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { SaveDialogOptions } from "@tauri-apps/plugin-dialog";

/**
 * The native "where should this land" panel, wrapped so a refusal stays visible.
 *
 * Asking for a path is the one step of an export that can fail before anything
 * is written: the panel is gated by the shell's permission list, and a denial
 * comes back as a rejection rather than a return value. Swallowing that (as the
 * two export dialogs used to) makes a misconfigured permission look like a dead
 * button — nothing happens, nothing is said, and there is no thread to pull. So
 * the reason is kept and handed to the dialog to show.
 *
 * Cancelling is not a failure: it is `null`, with no message.
 */
export function useSavePath() {
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(async (options: SaveDialogOptions): Promise<string | null> => {
    setError(null);
    try {
      return await save(options);
    } catch (cause) {
      setError(`无法打开保存对话框：${reason(cause)}`);
      return null;
    }
  }, []);

  return { choose, error };
}

/** A thrown value's message. Tauri rejects with a plain string, not an `Error`. */
function reason(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
