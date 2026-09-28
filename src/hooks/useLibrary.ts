import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onImportProgress } from "@/lib/ipc";
import { demoBooks, demoEnabled, demoLibraryStats } from "@/lib/demo";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { renderFirstPagePng } from "@/lib/pdf";
import type { BookMetadataPatch, BookQuery, BookSummary, ImportProgress } from "@/types/ipc";

/** Shelf contents for one filter/sort/search combination. */
export function useBooks(query: BookQuery) {
  return useQuery<BookSummary[]>({
    queryKey: ["books", query.filter, query.sort, query.search ?? "", query.tag ?? ""],
    queryFn: () => {
      // `?demo=1` is the sample shelf, and an explicit one: without it the web
      // build reads the books the reader imported here (IndexedDB), the same
      // way the desktop reads its own.
      if (demoEnabled()) return Promise.resolve(demoBooks);
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
      if (demoEnabled()) return Promise.resolve(demoLibraryStats);
      return ipc.bookStats();
    },
    staleTime: 10_000,
  });
}

function useInvalidateShelf() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["books"] });
}

/** Book ids whose cover backfill already ran this session, so a failure or a
    slow render never retries in a loop. */
const coverAttempted = new Set<string>();

/** A PDF's only cover is its first page, which Rust cannot rasterize — so the
    shelf backfills covers by rendering page 1 with pdf.js and handing the PNG
    to `book.cover_save`. Covers freshly imported PDFs too: they appear in the
    list without one and the invalidated query picks the cover up. */
export function usePdfCovers(books: BookSummary[]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isDesktopRuntime) return;
    const pending = books.filter(
      (book) => book.format === "pdf" && !book.coverUrl && !coverAttempted.has(book.id),
    );
    if (pending.length === 0) return;
    /**
     * One at a time, and one invalidation for the whole pass.
     *
     * This used to fire every PDF at once and refresh the shelf once per
     * book: a shelf of thirty PDFs parsed thirty documents concurrently (each
     * one a `getDocument` plus a page render) and refetched the same query
     * thirty times. A cover measured 126 ms on WebKit, so the concurrent
     * version spent seconds of it fighting the shelf's own first paint.
     *
     * `coverAttempted` is still written before the work starts, so a failure
     * never retries in a loop, and the cleanup only stops the trailing
     * invalidation — a pass that is already running is allowed to finish.
     */
    let cancelled = false;
    void (async () => {
      for (const book of pending) {
        coverAttempted.add(book.id);
        try {
          const bytes = await renderFirstPagePng(book.id);
          await ipc.bookCoverSave(book.id, Array.from(new Uint8Array(bytes)));
        } catch {
          // Scanned or damaged PDFs simply keep the placeholder cover.
        }
      }
      if (!cancelled) await queryClient.invalidateQueries({ queryKey: ["books"] });
    })();
    return () => {
      cancelled = true;
    };
  }, [books, queryClient]);
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
      ipc.bookImport(paths, password ?? null),
    onSettled: invalidate,
  });
}

/** Imports files the browser picked, and refreshes the shelf when done. Same
 *  outcomes as `useImportBooks`, so the sheet that reports them is shared. */
export function useImportFiles() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (files: File[]) => ipc.bookImportFiles(files),
    onSettled: invalidate,
  });
}

/** Saves a book's own file: to the path the save dialog gave (desktop), or to
 *  the downloads folder (browser, which ignores the path). Nothing to
 *  invalidate — the shelf is untouched and the bytes were already stored.
 */
export function useExportBookFile() {
  return useMutation({
    mutationFn: ({ id, path = "" }: { id: string; path?: string }) => ipc.bookExport(id, path),
  });
}

/** Writes one book to a `.ctz` / `.ctzx` pack. Nothing to invalidate: the
 * shelf is untouched, the file lands wherever the save dialog pointed.
 */
export function useExportPack() {
  return useMutation({
    mutationFn: ({ id, path, password }: { id: string; path: string; password?: string }) =>
      ipc.packExport(id, path, password ?? null),
  });
}

export function useDeleteBook() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (id: string) => ipc.bookDelete(id),
    onSettled: invalidate,
  });
}

/** Deletes a whole selection in one transaction, for the shelf's batch bar.
 *
 * The per-id version refreshed the book list once per book — twenty books
 * meant twenty IPC round trips and twenty invalidations of the same query. */
export function useDeleteBooks() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (ids: string[]) => ipc.bookDeleteMany(ids),
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

/** Marks a whole selection, in one transaction. Same reason as
 *  [`useDeleteBooks`]. */
export function useSetFavorites() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: ({ ids, favorite }: { ids: string[]; favorite: boolean }) =>
      ipc.bookSetFavoriteMany(ids, favorite),
    onSettled: invalidate,
  });
}

/** Rewrites a book's metadata (title, authors, description, …).
 *
 * The whole form travels, so a half-filled sheet never clears a field it did
 * not show — see `BookMetaDialog`. `onSuccess` rather than `onSettled`: a
 * rejected edit changed nothing, and refetching then would only re-render the
 * shelf with the values the reader was trying to replace.
 */
export function useUpdateBook() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BookMetadataPatch }) =>
      ipc.bookUpdate(id, patch),
    onSuccess: invalidate,
  });
}

/** Live import progress from the backend. Returns `null` between batches so
 * the UI can switch between progress and summary states.
 */
export function useImportProgress(): ImportProgress | null {
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  useTauriEvent(onImportProgress, setProgress);

  return progress;
}
