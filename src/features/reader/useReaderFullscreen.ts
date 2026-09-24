import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useChrome } from "@/stores/chrome";
import { isDesktopRuntime } from "@/lib/ipc";

/** How long the "press Esc to leave" hint stays up after entering fullscreen. */
const EXIT_HINT_MS = 3000;

/** Whether the page itself is fullscreen — the browser's own notion, which is
 *  what `fullscreenchange` reports. */
const pageIsFullscreen = (): boolean => document.fullscreenElement !== null;

/**
 * Enters or leaves the browser's fullscreen, answering what actually happened.
 *
 * The element API is not everywhere — iOS Safari offers `requestFullscreen` on
 * nothing but a video — and a browser may refuse the request when it arrives
 * outside a user gesture. Both cases fall back to the one thing this hook can
 * always give: the chrome hidden, rather than a button that does nothing.
 *
 * The answer is read back from the document instead of assumed: the request
 * resolves asynchronously, and the state is the browser's to set.
 */
async function togglePageFullscreen(current: boolean): Promise<boolean> {
  const root = document.documentElement;
  try {
    if (pageIsFullscreen()) await document.exitFullscreen();
    else if (typeof root.requestFullscreen === "function") await root.requestFullscreen();
    else return !current;
  } catch {
    return !current;
  }
  return pageIsFullscreen();
}

/**
 * The reader's fullscreen state, mirroring the window's.
 *
 * Mirroring, not owning: macOS can leave fullscreen without our toggle — the
 * traffic-light green dot or a native gesture — and the window resize that
 * follows is the only signal, so the real state is re-read there and both the
 * local flag and the shell's chrome flag are brought back in line. The browser
 * has the same shape of problem, answered by `fullscreenchange` (Esc, a system
 * gesture, or another script leaving it).
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
      next = await togglePageFullscreen(fullscreen);
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
    if (!isDesktopRuntime) {
      // Esc, a system gesture, or another script can all leave fullscreen
      // without the toggle being pressed, and this event is the only notice.
      const onChange = () => {
        const actual = pageIsFullscreen();
        setFullscreen(actual);
        setReaderFullscreen(actual);
      };
      document.addEventListener("fullscreenchange", onChange);
      return () => document.removeEventListener("fullscreenchange", onChange);
    }
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
