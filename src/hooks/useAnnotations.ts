import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import {
  demoAnnotationDelete,
  demoAnnotationList,
  demoAnnotationNote,
  demoEnabled,
} from "@/lib/demo";
import type { Annotation, AnnotationStyle, NewAnnotation } from "@/types/ipc";

/** The cache key every annotation view shares. Exported so the notes page can
 *  aggregate across books without inventing a second key for the same rows. */
export const annotationsKey = (bookId: string) => ["annotations", bookId];

/**
 * Browser dev with `?demo=1` reads the sample store instead of the backend.
 *
 * Read once at module scope: the document URL is fixed for the life of the
 * app (the router is in memory), so this cannot change under a render. On
 * desktop `isDesktopRuntime` short-circuits it before `demoEnabled()` is even
 * asked, which is what keeps the fixture unreachable in the shipped build.
 */
const demoMode = !isDesktopRuntime && demoEnabled();

/** One book's highlights, from whichever source this runtime has. */
function listAnnotations(bookId: string): Promise<Annotation[]> {
  if (demoMode) return Promise.resolve(demoAnnotationList(bookId));
  return ipc.annotationList(bookId);
}

/** Every highlight for a book, in reading order. */
export function useAnnotations(bookId: string | null) {
  return useQuery({
    queryKey: annotationsKey(bookId ?? ""),
    queryFn: () => (bookId ? listAnnotations(bookId) : Promise.resolve<Annotation[]>([])),
    enabled: bookId !== null,
    staleTime: 30_000,
  });
}

/**
 * Every book's highlights at once — the notes page's read path.
 *
 * One query per book, on the very key `useAnnotations` uses, so the two views
 * share cache entries: a note written in the reader is already here when the
 * page comes back, with no refetch and no second copy of the data. That is the
 * whole reason this is a view over the reader's store rather than a store of
 * its own.
 *
 * The cost is one command per book. `annotation_list` is the only enumeration
 * the backend has — there is no cross-book listing, and no count to filter by
 * first — so a shelf of N books costs N indexed reads. They run concurrently
 * and each is cheap, so a few hundred books land in about one round trip; but
 * it is N queries, not one, and this is the shape that would change if a bulk
 * command ever lands.
 */
export function useAnnotationsByBook(bookIds: readonly string[]) {
  return useQueries({
    queries: bookIds.map((id) => ({
      queryKey: annotationsKey(id),
      queryFn: () => listAnnotations(id),
      staleTime: 30_000,
    })),
    // Folded here rather than in the page so the array index never leaks out:
    // `useQueries` answers in the order it was asked, and a caller that has to
    // remember that is a caller that will eventually get it wrong.
    combine: (results) => {
      const byBook = new Map<string, Annotation[]>();
      results.forEach((result, index) => {
        const id = bookIds[index];
        if (id !== undefined) byBook.set(id, result.data ?? []);
      });
      return { byBook, loading: results.some((result) => result.isPending) };
    },
  });
}

/** Creates a highlight and inserts it into the cached list in place. */
export function useCreateAnnotation(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<NewAnnotation, "bookId">) => {
      if (!bookId) return Promise.resolve<Annotation | null>(null);
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

/**
 * Deletes a highlight and drops it from the cached list.
 *
 * The three mutations the notes page reaches for — this one, the batch delete
 * below and the note write further down — carry a `demoMode` branch so the
 * surface works end to end in a browser. Creating, restyling and anchoring stay
 * backend-only: they are the reader's own paths, and the reader is not the
 * surface `?demo=1` exists to stand in for.
 */
export function useDeleteAnnotation(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      if (!bookId) return Promise.resolve();
      if (demoMode) return Promise.resolve(demoAnnotationDelete(id));
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

/**
 * Deletes a set of highlights gathered from anywhere on the shelf.
 *
 * One request for the whole selection, and one transaction on the other side:
 * the notes page's selection spans books, so the per-book mutation above would
 * be a round trip per row, and a failure half way through would leave the shelf
 * partly deleted.
 *
 * The cache patch is the part worth spelling out. A selection is a set of ids
 * and the page has no idea which books they came from, so *every* annotation
 * list is filtered rather than one being found and patched. Books that lost
 * nothing are rewritten to an equal array, which TanStack compares shallowly
 * and does not re-render for.
 */
export function useDeleteAnnotations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: readonly string[]) => {
      if (ids.length === 0) return Promise.resolve(0);
      if (demoMode) {
        for (const id of ids) demoAnnotationDelete(id);
        return Promise.resolve(ids.length);
      }
      return ipc.annotationDeleteMany([...ids]);
    },
    onSuccess: (_removed, ids) => {
      if (ids.length === 0) return;
      const gone = new Set(ids);
      // `["annotations"]` as a prefix, not `annotationsKey(...)`: the key is
      // per book and this mutation is deliberately not.
      queryClient.setQueriesData<Annotation[]>({ queryKey: ["annotations"] }, (old) =>
        old ? old.filter((annotation) => !gone.has(annotation.id)) : old,
      );
    },
  });
}

/** Restyles a highlight in place (the toolbar's re-colour / re-shape path). */
export function useUpdateAnnotation(bookId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, color, style }: { id: string; color?: string; style?: AnnotationStyle }) => {
      if (!bookId) {
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
      if (!bookId) return Promise.resolve<Annotation | null>(null);
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
      if (!bookId) return Promise.resolve<Annotation | null>(null);
      if (demoMode) return Promise.resolve(demoAnnotationNote(id, note));
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
    mutationFn: ({
      id,
      name,
      path,
      format,
    }: {
      id: string;
      name: string;
      /** Where the desktop writes, from its save panel. `null` in the browser,
       *  whose file goes to a download instead — and takes `name`. */
      path: string | null;
      format: string;
    }) => (path === null ? ipc.notesSave(id, name, format) : ipc.notesExport(id, path)),
  });
}

/**
 * Writes out a set of highlights gathered from anywhere on the shelf — what the
 * notes page is showing, or the rows picked out of it.
 *
 * `bookIds` carries the page's own order and `ids` the set itself: the backend
 * groups by book and keeps reading order inside each, so passing the books is
 * what makes the file read the way the screen does, and passing the ids is what
 * keeps a search or the 有笔记 filter from being silently ignored.
 */
export function useExportNotesSelection() {
  return useMutation({
    mutationFn: ({
      bookIds,
      ids,
      name,
      path,
      format,
    }: {
      bookIds: string[];
      ids: string[];
      name: string;
      /** Where the desktop writes, from its save panel. `null` in the browser,
       *  whose file goes to a download instead — the name it gets is `name`. */
      path: string | null;
      format: string;
    }) =>
      path === null
        ? ipc.notesSaveSelection(bookIds, ids, name, format)
        : ipc.notesExportSelection(bookIds, ids, path),
  });
}
