import { useQuery } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { SearchHit } from "@/types/ipc";

/**
 * Chapters whose text contains `needle`, best match first.
 *
 * Queries are cheap enough to run on every keystroke: the index lives in
 * SQLite on the same machine, so debouncing would only add lag.
 */
export function useSearch(needle: string, bookId: string | null) {
  const trimmed = needle.trim();
  return useQuery({
    queryKey: ["search", trimmed, bookId],
    queryFn: () => {
      if (!isDesktopRuntime) return Promise.resolve<SearchHit[]>([]);
      return ipc.searchQuery(trimmed, bookId);
    },
    enabled: trimmed.length > 0,
    staleTime: 10_000,
  });
}
