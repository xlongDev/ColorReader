import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { Annotation, AnnotationStyle, NewAnnotation } from "@/types/ipc";

const annotationsKey = (bookId: string) => ["annotations", bookId];

/** Every highlight for a book, in reading order. */
export function useAnnotations(bookId: string | null) {
  return useQuery({
    queryKey: annotationsKey(bookId ?? ""),
    queryFn: () => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<Annotation[]>([]);
      return ipc.annotationList(bookId);
    },
    enabled: bookId !== null,
    staleTime: 30_000,
  });
}

/** Creates a highlight and inserts it into the cached list in place. */
export function useCreateAnnotation(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<NewAnnotation, "bookId">) => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<Annotation | null>(null);
      return ipc.annotationCreate(
        bookId,
        input.chapterIdx,
        input.startChar,
        input.endChar,
        input.text,
        input.cfi ?? null,
        input.color ?? null,
        input.style ?? null,
      );
    },
    onSuccess: (created) => {
      if (!bookId || !created) return;
      queryClient.setQueryData<Annotation[]>(annotationsKey(bookId), (old = []) =>
        [...old, created].toSorted(
          (a, b) => a.chapterIdx - b.chapterIdx || a.startChar - b.startChar,
        ),
      );
    },
  });
}

/** Deletes a highlight and drops it from the cached list. */
export function useDeleteAnnotation(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve();
      return ipc.annotationDelete(id);
    },
    onSuccess: (_result, id) => {
      if (!bookId) return;
      queryClient.setQueryData<Annotation[]>(annotationsKey(bookId), (old = []) =>
        old.filter((annotation) => annotation.id !== id),
      );
    },
  });
}

/** Restyles a highlight in place (the toolbar's re-colour / re-shape path). */
export function useUpdateAnnotation(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, color, style }: { id: string; color?: string; style?: AnnotationStyle }) => {
      if (!bookId || !isDesktopRuntime) {
        return Promise.resolve<Annotation | null>(null);
      }
      return ipc.annotationUpdate(id, color ?? null, style ?? null);
    },
    onSuccess: (updated) => {
      if (!bookId || !updated) return;
      queryClient.setQueryData<Annotation[]>(annotationsKey(bookId), (old = []) =>
        old.map((annotation) => (annotation.id === updated.id ? updated : annotation)),
      );
    },
  });
}

/**
 * Gives a highlight imported from a clippings file the foliate anchor it was
 * written without. The reader calls this the first time it renders the section
 * holding the highlight's text; from then on every path — painting, clicking,
 * jumping to it — treats it like any other highlight.
 *
 * The cache is patched rather than invalidated: this fires while the reader is
 * looking at the page, and refetching the list would repaint every highlight.
 */
export function useAnchorAnnotation(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cfi }: { id: string; cfi: string }) => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<Annotation | null>(null);
      return ipc.annotationAnchor(id, cfi);
    },
    onSuccess: (updated) => {
      if (!bookId || !updated) return;
      queryClient.setQueryData<Annotation[]>(annotationsKey(bookId), (old = []) =>
        old.map((annotation) => (annotation.id === updated.id ? updated : annotation)),
      );
    },
  });
}

/**
 * Writes — or clears — the reader's own note on a highlight. Patched into the
 * cache rather than invalidated, for the same reason anchoring is: it happens
 * while the reader is looking at the page, and a refetch would repaint every
 * highlight on it.
 */
export function useSetAnnotationNote(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string | null }) => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<Annotation | null>(null);
      return ipc.annotationNote(id, note);
    },
    onSuccess: (updated) => {
      if (!bookId || !updated) return;
      queryClient.setQueryData<Annotation[]>(annotationsKey(bookId), (old = []) =>
        old.map((annotation) => (annotation.id === updated.id ? updated : annotation)),
      );
    },
  });
}

/**
 * Writes one book's highlights and notes out as a file the reader keeps.
 *
 * It lives here rather than with the shelf's own export because it exports
 * *annotations*: the reader reaches it from the annotation list, and pulling
 * the library module in for one mutation would drag the shelf's cover-rendering
 * import along with it.
 */
export function useExportNotes() {
  return useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) => {
      if (!isDesktopRuntime) return Promise.resolve();
      return ipc.notesExport(id, path);
    },
  });
}
