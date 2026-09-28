import { useCallback, useEffect, useRef, useState } from "react";

import type { Panel } from "@/features/reader/ReaderChrome";

/**
 * Which side panel the reader has open, and the search drawer's query.
 *
 * Only one panel at a time, so they never stack, and the whole thing is two
 * cells of state — but it is worth a hook for `close` alone.
 *
 * Closing is not just "set it to none". The search drawer leaves two things
 * behind: its query, and the match highlights foliate painted into the pages.
 * There are two ways out — the drawer's own ✕, and Escape — and the rule used
 * to be written at each of them separately, which is exactly how the Escape
 * path came to clear the query and leave the highlights painted on the page
 * (`foliateRef.clearSearch()` had a single call site, inside the ✕). One
 * function now owns both halves, so a third way out cannot forget one.
 *
 * `setPanel` is exposed raw for the places that close the drawer because they
 * are navigating away — jumping to a chapter, a bookmark, a hit. Those
 * deliberately leave the query and the painted matches alone: they are still
 * the reader's context if they come back to the drawer.
 */
export interface ReaderPanelControls {
  panel: Panel;
  setPanel: (next: Panel) => void;
  /** The chrome's panel button: the same id closes the panel it names. */
  toggle: (id: Exclude<Panel, "none">) => void;
  /** The search drawer's query. */
  search: string;
  /** What the drawer should search for next — the toolbar's 搜索 action, and
   *  picking a hit. */
  setSearch: (query: string) => void;
  /**
   * The drawer's own way out, and the only one that cleans up after it.
   * Returns whether anything was open, so a key handler can tell "I consumed
   * this Escape" from "pass it on".
   */
  close: () => boolean;
}

export function useReaderPanels(
  initialQuery: string,
  clearPaintedMatches: () => void,
): ReaderPanelControls {
  const [panel, setPanel] = useState<Panel>("none");
  const [search, setSearch] = useState(initialQuery);
  /** What is open *now*. `close` has to keep one identity — it goes into the
   *  key handler's dependency list — so it cannot read `panel` from a closure
   *  that a re-render may have replaced. */
  const panelRef = useRef<Panel>("none");
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  const toggle = useCallback(
    (id: Exclude<Panel, "none">) => setPanel((current) => (current === id ? "none" : id)),
    [],
  );

  const close = useCallback(() => {
    if (panelRef.current === "none") return false;
    if (panelRef.current === "search") {
      setSearch("");
      clearPaintedMatches();
    }
    // Written synchronously as well as into state: two closes in a row (a ✕
    // and an Escape, a double-press) must not clean up twice.
    panelRef.current = "none";
    setPanel("none");
    return true;
  }, [clearPaintedMatches]);

  return { panel, setPanel, toggle, search, setSearch, close };
}
