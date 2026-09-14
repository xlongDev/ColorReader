import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { TagSummary } from "@/types/ipc";

/**
 * The shelf's labels: the tag bar reads them, the label editor writes them.
 *
 * Labels are ordinary rows, not a second shelf — a book keeps its place in the
 * grid and gains a name that can be filtered on. Both actions refresh the tag
 * list and the book list together, because one edit can add or retire a tag.
 */

/** Every tag in use, with its book count. */
export function useTags() {
  return useQuery<TagSummary[]>({
    queryKey: ["tags"],
    queryFn: () => (isDesktopRuntime ? ipc.tagList() : Promise.resolve([])),
    staleTime: 30_000,
  });
}

function useInvalidateLabels() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["books"] }),
    ]);
}

/**
 * Attaches and detaches labels on a set of books.
 *
 * `remove` is always explicit: the per-book sheet sends the difference between
 * what it showed and what the reader kept, while the batch bar leaves it empty
 * so selecting books can never clear a label it never saw.
 */
export function useAssignTags() {
  const invalidate = useInvalidateLabels();
  return useMutation({
    mutationFn: ({ ids, add, remove }: { ids: string[]; add: string[]; remove: string[] }) =>
      isDesktopRuntime ? ipc.bookSetTags(ids, add, remove) : Promise.resolve(),
    onSettled: invalidate,
  });
}

/** Drops a tag from every book that carries it. */
export function useDeleteTag() {
  const invalidate = useInvalidateLabels();
  return useMutation({
    mutationFn: (id: string) => (isDesktopRuntime ? ipc.tagDelete(id) : Promise.resolve()),
    onSettled: invalidate,
  });
}
