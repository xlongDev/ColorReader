import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { LocalDictionary } from "@/types/ipc";

/** The imported dictionaries. Only this page and the import dialog change them. */
export function useDictionaries() {
  return useQuery<LocalDictionary[]>({
    queryKey: ["dictionaries"],
    queryFn: () => (isDesktopRuntime ? ipc.dictionaryList() : Promise.resolve([])),
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

/** Imports the bundle whose `.ifo` sits at `path`. */
export function useImportDictionary() {
  const invalidate = useDictionaryInvalidation();
  return useMutation({
    mutationFn: (path: string) => ipc.dictionaryImport(path),
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
