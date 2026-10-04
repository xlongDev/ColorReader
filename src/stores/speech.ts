import { create } from "zustand";

import type { SpeechTransport, SpeechUnit, SpeechView } from "@/features/reader/speech";

/**
 * The read-aloud session, shared by the reader and the shell's player.
 *
 * The player used to live inside `ReaderPage` and die with it: leaving the
 * reader cancelled the voice mid-sentence, which is exactly what a reader
 * listening to a book while browsing their shelf does not want. The engine and
 * the player now sit in the shell (`TtsHost`), and this store is the seam — the
 * reader publishes what is being read and hands over its transport while it is
 * on screen, and the player renders from whatever is left when it is not.
 *
 * Not persisted, and it must not be: a session is the voice that is speaking
 * right now, not a preference. `speechRate` / `speechVoiceURI` — the parts worth
 * keeping — live in `useReaderSettings`.
 */
interface SpeechSessionState {
  /** The book the voice belongs to, or `null` before the first session. Read
   *  by the reader on mount, to tell "carry on with this book" from "the voice
   *  is reading something else entirely". */
  bookId: string | null;
  title: string;
  coverUrl: string | null;
  /** Chapter (prose) or section (Kindle) label, under the title. */
  chapter: string;
  /** The chapter the voice is inside — the second half of the same check. A
   *  reader coming back to a *different* chapter must not adopt the queue. */
  chapterIdx: number;
  /** BCP-47 tag of the book's language, for the voice picker's leading chips. */
  bookLanguage: string | null;
  /** The queue the voice is walking, exactly as the reader built it. */
  units: readonly SpeechUnit[];
  /** Transport lent by the mounted reader; `null` while the voice plays on
   *  alone, which is when the player drives the engine itself. */
  controls: SpeechTransport | null;
  /** The full card. The bar is governed by the engine's status instead. */
  open: boolean;
  /** Which of the card's four views the next open lands on. The reader's own
   *  倍速 button is a shortcut *past* the tiles and straight into 语速, and the
   *  capsule's is not — so this is the one thing about opening that has to be
   *  said rather than derived. Reset to `main` on every open that does not name
   *  a view, so the shortcut never becomes where the next reader lands too. */
  openAt: SpeechView;
  publish: (patch: SpeechSessionPatch) => void;
  setControls: (controls: SpeechTransport | null) => void;
  setOpen: (open: boolean, at?: SpeechView) => void;
}

/** What a reader says about the session it is running. */
export type SpeechSessionPatch = Partial<
  Pick<
    SpeechSessionState,
    "bookId" | "title" | "coverUrl" | "chapter" | "chapterIdx" | "bookLanguage" | "units"
  >
>;

export const useSpeechSession = create<SpeechSessionState>()((set) => ({
  bookId: null,
  title: "",
  coverUrl: null,
  chapter: "",
  chapterIdx: 0,
  bookLanguage: null,
  units: [],
  controls: null,
  open: false,
  openAt: "main",
  publish: (patch) => set(patch),
  setControls: (controls) => set({ controls }),
  setOpen: (open, at = "main") => set({ open, openAt: at }),
}));

/** The session as it stands outside a render — the reader's mount check reads
 *  it before it publishes anything, and must not be answered by this render's
 *  own (stale) subscription. */
export const sessionNow = () => useSpeechSession.getState();
