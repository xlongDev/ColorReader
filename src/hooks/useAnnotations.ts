import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { Annotation, NewAnnotation } from "@/types/ipc";

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
      return ipc.annotationCreate({ ...input, bookId });
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
