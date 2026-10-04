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
  /**
   * How tall the reader's own windowed footer is right now, in CSS pixels, or
   * `0` when it is not on screen.
   *
   * The read-aloud pill is anchored to the content pane's bottom edge and the
   * footer is *inside* that pane, so the pill has to be lifted by however much
   * the footer takes or it sits on the reader's controls. That number used to be
   * a constant measured once by hand — 58px, carrying a `ponytail:` note that it
   * would drift — and a platform whose type metrics are taller than ours (a CI
   * runner with no CJK font installed, say) grew the footer to 78px, which left
   * the pill 8px above the footer instead of 20. Measured where the footer
   * already is, it is the same number everywhere; published here because the
   * footer belongs to the reader and the pill to the shell.
   */
  readerFooterHeight: number;
  setReaderFooterHeight: (height: number) => void;
}

export const useChrome = create<ChromeState>()((set) => ({
  readerFullscreen: false,
  setReaderFullscreen: (readerFullscreen) => set({ readerFullscreen }),
  readerReturnPath: "/",
  setReaderReturnPath: (readerReturnPath) => set({ readerReturnPath }),
  readerFooterHeight: 0,
  setReaderFooterHeight: (readerFooterHeight) => set({ readerFooterHeight }),
}));
