import { create } from "zustand";

/**
 * What the chrome knows about pages that have no text layer.
 *
 * The fact itself is produced deep in the reader: `PdfPageView` is the only
 * thing that builds a pdf.js text layer, so it is the only thing that can say
 * whether a page came out empty. The thing that has to act on it — the footer's
 * scan chip — sits outside the page entirely, and that is the point: a notice
 * drawn inside the page covers the page it is talking about.
 *
 * Two sets, both keyed by book *and* page:
 *
 * - `empty` is every page whose finished text layer held no characters. Only
 *   the empty ones are kept, because a page with text and a page whose layer
 *   has not been built yet mean the same thing to every caller — nothing to
 *   say. That is also what keeps "not built yet" from masquerading as "empty":
 *   an entry exists only once a build has finished, so no window of a build
 *   can be read as a verdict. (It was read that way once: the notice flashed
 *   over every page of every ordinary PDF.)
 * - `recognised` is every page a single-page recognition has stored text for.
 *   It lives here rather than in the component because the reader navigates
 *   away and back: a page that has text must not be offered a second
 *   recognition, because the backend refuses it and the reader reads that
 *   refusal as a failure. A whole-book run keeps its own list — see `ocrRun`.
 *
 * `ponytail:` the sets grow one short string per page ever rendered in this
 * session, a few tens of KB for a thousand-page book. No eviction until
 * something measures a reason for it.
 */

/** The identity of one page of one book, as both sets spell it. */
export const scanKey = (bookId: string, page: number) => `${bookId}|${page}`;

/** `set` with `key` added or removed — and returned unchanged when it already
    agrees, so a repeated verdict costs no subscriber a render. */
function withKey(set: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> {
  if (set.has(key) === present) return set;
  const next = new Set(set);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

interface ScanPagesState {
  empty: ReadonlySet<string>;
  recognised: ReadonlySet<string>;
  /** Records what a finished text layer build found. */
  report: (bookId: string, page: number, empty: boolean) => void;
  /** Records that `page` has text now, put there by a recognition. */
  markRecognised: (bookId: string, page: number) => void;
}

export const useScanPages = create<ScanPagesState>()((set) => ({
  empty: new Set(),
  recognised: new Set(),

  report: (bookId, page, empty) =>
    set((state) => {
      const next = withKey(state.empty, scanKey(bookId, page), empty);
      // A settled page reports the same verdict every time it is rebuilt — a
      // resize, a theme flip, a zoom. Handing back the same set is what keeps
      // those from waking anything up.
      return next === state.empty ? {} : { empty: next };
    }),

  markRecognised: (bookId, page) =>
    set((state) => ({ recognised: withKey(state.recognised, scanKey(bookId, page), true) })),
}));
