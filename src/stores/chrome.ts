import { create } from "zustand";

/**
 * Ephemeral window chrome state. Not persisted: fullscreen is a per-session
 * viewing mode, and the OS already restores the window on relaunch.
 */
interface ChromeState {
  /** True while the reader owns the whole window; the shell drops its chrome. */
  readerFullscreen: boolean;
  setReaderFullscreen: (on: boolean) => void;
  /**
   * The route the reader was opened from, so 返回 lands on it.
   *
   * A book opens from six places — the four shelves, 笔记, 统计, 搜索 — and
   * the reader used to send all of them back to 书库, which is a lie the
   * reader has no reason to tell: the trip out is a push, so the page it came
   * from is still on the stack. Tracked here rather than read back off the
   * history because the reader also pushes onto itself (a RAG citation opens
   * another book), which would make "go back one" mean something else.
   *
   * Not persisted, and it should not be: it is where this session came from,
   * not a preference. `/` is the answer for a `colorreader://` link, which
   * arrives without ever having been anywhere.
   */
  readerReturnPath: string;
  setReaderReturnPath: (path: string) => void;
}

export const useChrome = create<ChromeState>()((set) => ({
  readerFullscreen: false,
  setReaderFullscreen: (readerFullscreen) => set({ readerFullscreen }),
  readerReturnPath: "/",
  setReaderReturnPath: (readerReturnPath) => set({ readerReturnPath }),
}));
