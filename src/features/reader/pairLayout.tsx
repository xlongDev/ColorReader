import { createContext, useContext } from "react";

/**
 * What one pane of a 对照阅读 pair tells the pair's top bar about itself:
 * which book it is, where it is open, and the three things the bar can do to
 * it — open it, turn its page, and leave the reader. The page turn is a verb
 * on purpose: each book has its own steppers up there, and pressing the other
 * book's must not require making it active first.
 */
export interface PairIdentity {
  coverUrl: string | null;
  title: string;
  /** 1-based position in the chapter list, or the page number for a PDF. */
  index: number;
  total: number;
  isPdf: boolean;
  /** Chapter heading, shown for prose books only. */
  chapterLabel: string;
  /** Where 返回 goes from this book, and what the button is called there. */
  backLabel: string;
  onBack: () => void;
  /** Turns this book's page, from the bar above it. */
  onStep: (dir: 1 | -1) => void;
}

interface PairSlotsValue {
  /** The pair's one bottom bar, as a place to paint chrome into. */
  bottom: HTMLElement | null;
}

const PairSlotsContext = createContext<PairSlotsValue>({ bottom: null });

/**
 * The pair's bottom bar, as DOM a pane can render into.
 *
 * 对照阅读 has one bar above the books — rendered by `SplitReader`, naming
 * both and giving each its own steppers — and one bar below them, holding the
 * active book's controls. Only the bottom one has to be painted by a pane: its
 * controls belong to one reader, and the portal keeps every one of them bound
 * to that reader (DOM moves, state does not).
 *
 * A `null` slot means "not inside a pair", which is what the ordinary reader
 * sees; it renders its chrome inline.
 */
export const PairSlotsProvider = PairSlotsContext.Provider;

export function usePairSlots(): PairSlotsValue {
  return useContext(PairSlotsContext);
}
