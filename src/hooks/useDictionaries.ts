import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import type { LocalDictionary } from "@/types/ipc";

/** The imported dictionaries. Only this page and the import dialog change them. */
export function useDictionaries() {
  return useQuery<LocalDictionary[]>({
    queryKey: ["dictionaries"],
    queryFn: () => ipc.dictionaryList(),
    staleTime: 30_000,
  });
}

/**
 * Adding or dropping a dictionary changes what a word resolves to, so both
 * mutations also drop the per-term lookup cache — its entries never expire, and
 * a word that missed before would otherwise keep reporting 未收录 forever.
 * The two keys are distinct strings, so invalidating one does not touch the
 * other.
 */
function useDictionaryInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["dictionaries"] });
    void queryClient.invalidateQueries({ queryKey: ["dictionary"] });
  };
}

/**
 * Imports one dictionary.
 *
 * A path on the desktop (its dialog hands one over, and a StarDict bundle's
 * siblings are found next to it) and the `File` itself in the browser. The
 * browser takes `.mdx` only — one file, which is the only shape a file picker
 * can ask for — and says so when it is handed anything else.
 */
export function useImportDictionary() {
  const invalidate = useDictionaryInvalidation();
  return useMutation({
    mutationFn: (source: string | File) =>
      typeof source === "string" ? ipc.dictionaryImport(source) : ipc.dictionaryImportFile(source),
    meta: { silent: true },
    onSuccess: invalidate,
  });
}

/** Forgets one dictionary and deletes its files. */
export function useDeleteDictionary() {
  const invalidate = useDictionaryInvalidation();
  return useMutation({
    mutationFn: (id: string) => ipc.dictionaryDelete(id),
    onSuccess: invalidate,
  });
}
