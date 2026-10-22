import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

/**
 * How long typing settles before a query is sent.
 *
 * The search is a scan of every chapter body (see `retrieval/search.rs`): ~150
 * ms across a library of 83 M characters. Cheap enough for one query, too
 * expensive for one per keystroke — four characters typed quickly would put
 * four full scans back to back and flash the skeleton between each. 150 ms is
 * shorter than the pause between two words, so a reader who types and stops
 * sees one query, and one who types slowly still sees results as they go.
 */
const SETTLE_MS = 150;

/** `value`, once it has stopped changing for `delay`. The first value is
 *  immediate, so a panel that opens with a query already in it does not wait. */
function useSettled(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return settled;
}

/**
 * Chapters whose text contains `needle`, spread across the books that hold it.
 *
 * The query key is the settled needle, so a burst of keystrokes is one cache
 * entry rather than four that are immediately stale.
 */
export function useSearch(needle: string, bookId: string | null) {
  const trimmed = needle.trim();
  const settled = useSettled(trimmed, SETTLE_MS);
  return useQuery({
    queryKey: ["search", settled, bookId],
    queryFn: () => {
      return ipc.searchQuery(settled, bookId, null);
    },
    enabled: settled.length > 0,
    staleTime: 10_000,
  });
}
