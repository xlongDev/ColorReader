import { create } from "zustand";

/**
 * Ephemeral window chrome state. Not persisted: fullscreen is a per-session
 * viewing mode, and the OS already restores the window on relaunch.
 */
interface ChromeState {
  /** True while the reader owns the whole window; the shell drops its chrome. */
  readerFullscreen: boolean;
  setReaderFullscreen: (on: boolean) => void;
}

export const useChrome = create<ChromeState>()((set) => ({
  readerFullscreen: false,
  setReaderFullscreen: (readerFullscreen) => set({ readerFullscreen }),
}));
