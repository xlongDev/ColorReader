import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onImportProgress } from "@/lib/ipc";
import type { BookQuery, BookSummary, ImportProgress } from "@/types/ipc";

/** Shelf contents for one filter/sort/search combination. */
export function useBooks(query: BookQuery) {
  return useQuery<BookSummary[]>({
    queryKey: ["books", query.filter, query.sort, query.search ?? ""],
    queryFn: () => {
      // Browser dev mode has no backend: show an empty shelf instead of erroring.
      if (!isDesktopRuntime) return Promise.resolve([]);
      return ipc.bookList(query);
    },
    staleTime: 10_000,
  });
}

/** Aggregate counts for the shelf header. */
export function useLibraryStats() {
  return useQuery({
    queryKey: ["books", "stats"],
    queryFn: () => {
      if (!isDesktopRuntime) {
        return Promise.resolve({ total: 0, favorites: 0, reading: 0, finished: 0 });
      }
      return ipc.bookStats();
    },
    staleTime: 10_000,
  });
}

function useInvalidateShelf() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["books"] });
}

/** Imports files by absolute path and refreshes the shelf when done.
 *
 * `password` is only consumed by encrypted `.ctzx` packs; every other format
 * ignores it, so a mixed batch needs at most one prompt.
 */
export function useImportBooks() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: ({ paths, password }: { paths: string[]; password?: string }) =>
      ipc.bookImport(paths, password),
    onSettled: invalidate,
  });
}

/** Writes one book to a `.ctz` / `.ctzx` pack. Nothing to invalidate: the
 * shelf is untouched, the file lands wherever the save dialog pointed.
 */
export function useExportPack() {
  return useMutation({
    mutationFn: ({ id, path, password }: { id: string; path: string; password?: string }) =>
      ipc.packExport(id, path, password),
  });
}

export function useDeleteBook() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (id: string) => ipc.bookDelete(id),
    onSettled: invalidate,
  });
}

export function useSetFavorite() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      ipc.bookSetFavorite(id, favorite),
    // Optimistic-free is fine at this size; the query is refreshed after.
    onSettled: invalidate,
  });
}

/** Live import progress from the backend. Returns `null` between batches so
 * the UI can switch between progress and summary states.
 */
export function useImportProgress(): ImportProgress | null {
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onImportProgress((next) => setProgress(next)).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  return progress;
}
