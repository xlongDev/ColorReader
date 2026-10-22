import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The two books open side by side in 对照阅读, or `null` when the reader is
 * alone.
 *
 * A pair is anchored on books rather than on panes, and deliberately in both
 * directions: opening either book brings the other back beside it (readest's
 * model — a pair is a relationship between two books, not a mode one of them
 * is in). The URL carries what is open *now* (`?book=A&pair=B`); this store
 * is what a relaunch restores from, and the reader page keeps the two in
 * sync.
 */
export type BookPair = [string, string];

interface PairViewState {
  pair: BookPair | null;
  /** Records the pair. A book paired with itself is refused — it would render
   *  the same book twice and call it a comparison. */
  setPair: (bookId: string, partnerId: string) => void;
  clearPair: () => void;
}

/**
 * The other book of the pair, given the one in hand; `null` when this book is
 * not in a pair (which includes "there is no pair at all").
 *
 * Pure so the restore path can ask without subscribing, and so the shape is
 * pinned by a test rather than by the two call sites that read it.
 */
export function partnerOf(pair: BookPair | null, bookId: string | null): string | null {
  if (pair === null || bookId === null) return null;
  if (pair[0] === bookId) return pair[1];
  if (pair[1] === bookId) return pair[0];
  return null;
}

export const usePairView = create<PairViewState>()(
  persist(
    (set) => ({
      pair: null,
      setPair: (bookId, partnerId) => {
        if (bookId === partnerId) return;
        set({ pair: [bookId, partnerId] });
      },
      clearPair: () => set({ pair: null }),
    }),
    {
      // No migrations yet: the only value is a pair of book ids, and a pair
      // naming a book that no longer exists simply fails to open (the pane
      // says so), which is the honest answer anyway.
      name: "fangce.pair",
      version: 1,
    },
  ),
);
