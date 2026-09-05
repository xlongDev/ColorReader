import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { Bookmark, NewBookmark } from "@/types/ipc";

const bookmarksKey = (bookId: string) => ["bookmarks", bookId];

/** Every bookmark for a book, in reading order. */
export function useBookmarks(bookId: string | null) {
  return useQuery({
    queryKey: bookmarksKey(bookId ?? ""),
    queryFn: () => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<Bookmark[]>([]);
      return ipc.bookmarkList(bookId);
    },
    enabled: bookId !== null,
    staleTime: 30_000,
  });
}

/** Creates a bookmark and inserts it into the cached list in place. */
export function useCreateBookmark(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<NewBookmark, "bookId">) => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<Bookmark | null>(null);
      return ipc.bookmarkCreate({ ...input, bookId });
    },
    onSuccess: (created) => {
      if (!bookId || !created) return;
      queryClient.setQueryData<Bookmark[]>(bookmarksKey(bookId), (old = []) =>
        [...old, created].toSorted(
          (a, b) => a.chapterIdx - b.chapterIdx || a.fraction - b.fraction,
        ),
      );
    },
  });
}

/** Deletes a bookmark and drops it from the cached list. */
export function useDeleteBookmark(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve();
      return ipc.bookmarkDelete(id);
    },
    onSuccess: (_result, id) => {
      if (!bookId) return;
      queryClient.setQueryData<Bookmark[]>(bookmarksKey(bookId), (old = []) =>
        old.filter((bookmark) => bookmark.id !== id),
      );
    },
  });
}
