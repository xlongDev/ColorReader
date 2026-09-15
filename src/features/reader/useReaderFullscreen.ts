import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useChrome } from "@/stores/chrome";
import { isDesktopRuntime } from "@/lib/ipc";

/** How long the "press Esc to leave" hint stays up after entering fullscreen. */
const EXIT_HINT_MS = 3000;

/**
 * The reader's fullscreen state, mirroring the OS window's.
 *
 * Mirroring, not owning: macOS can leave fullscreen without our toggle — the
 * traffic-light green dot or a native gesture — and the window resize that
 * follows is the only signal, so the real state is re-read there and both the
 * local flag and the shell's chrome flag are brought back in line.
 *
 * The exit hint is part of this because it is a property of entering, not of
 * anything the reader does afterwards.
 */
export function useReaderFullscreen() {
  const setReaderFullscreen = useChrome((s) => s.setReaderFullscreen);
  const [fullscreen, setFullscreen] = useState(false);

  const toggle = useCallback(async () => {
    let next: boolean;
    if (isDesktopRuntime) {
      try {
        const win = getCurrentWindow();
        next = !(await win.isFullscreen());
        await win.setFullscreen(next);
      } catch {
        // Permission or platform failure: degrade to hiding the chrome only.
        next = !fullscreen;
      }
    } else {
      next = !fullscreen;
    }
    setFullscreen(next);
    setReaderFullscreen(next);
  }, [fullscreen, setReaderFullscreen]);

  // The fullscreen exit hint pops when immersion starts and eases itself out
  // after a few seconds — discoverability without a permanent pill. Esc and
  // the header button keep working either way. Leaving fullscreen resets the
  // flag during render (the established render-time adjust pattern).
  const [exitHint, setExitHint] = useState(false);
  const [pillFor, setPillFor] = useState(fullscreen);
  if (pillFor !== fullscreen) {
    setPillFor(fullscreen);
    setExitHint(fullscreen);
  }
  useEffect(() => {
    if (!fullscreen) return;
    const timer = window.setTimeout(() => setExitHint(false), EXIT_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [fullscreen]);

  useEffect(() => {
    if (!isDesktopRuntime) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void win
      .onResized(async () => {
        try {
          const actual = await win.isFullscreen();
          if (!disposed) {
            setFullscreen(actual);
            setReaderFullscreen(actual);
          }
        } catch {
          // Query failed; the next resize will retry.
        }
      })
      .then((unlistenFn) => {
        if (disposed) unlistenFn();
        else unlisten = unlistenFn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setReaderFullscreen]);

  return { fullscreen, exitHint, toggle };
}
