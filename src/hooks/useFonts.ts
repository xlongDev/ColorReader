import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc } from "@/lib/ipc";
import { useReaderSettings } from "@/stores/reader";
import { customFontKey } from "@/features/reader/theme";
import type { LocalFont } from "@/types/ipc";

/** The fonts the reader imported. */
export function useFonts() {
  return useQuery<LocalFont[]>({
    queryKey: ["fonts"],
    // Browser dev mode has no backend; an empty list is the honest answer and
    // leaves the picker with the stacks every machine already has.
    queryFn: desktopQuery([], () => ipc.fontList()),
    staleTime: 30_000,
  });
}

/** Copies one font file in. */
export function useImportFont() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => ipc.fontImport(path),
    meta: { silent: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fonts"] });
    },
  });
}

/**
 * Forgets one font — and steps the picker off it when it was the one in use.
 *
 * Deleting the selected font would otherwise leave the reading surface asking
 * for a family that no longer has an `@font-face` anywhere, so the text would
 * quietly render in whatever the browser falls back to, with nothing on screen
 * to explain it. Returning to the system stack is the same state a fresh
 * install starts in, and it is one the reader can see.
 */
export function useDeleteFont() {
  const queryClient = useQueryClient();
  const selected = useReaderSettings((s) => s.fontFamily);
  const update = useReaderSettings((s) => s.update);
  return useMutation({
    mutationFn: (id: string) => ipc.fontDelete(id),
    onSuccess: (_deleted, id) => {
      if (selected === customFontKey(id)) update({ fontFamily: "system" });
      void queryClient.invalidateQueries({ queryKey: ["fonts"] });
    },
  });
}
