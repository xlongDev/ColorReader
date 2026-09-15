import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onSourceProgress } from "@/lib/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { SourceProgress, SourceRules } from "@/types/ipc";

/** Every stored source, definitions included. */
export function useSources() {
  return useQuery({
    queryKey: ["sources"],
    queryFn: () => {
      if (!isDesktopRuntime) return Promise.resolve([]);
      return ipc.sourceList();
    },
  });
}

/** Adds or updates one source; the id of a new source is returned. */
export function useSaveSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, def }: { id: string | null; def: SourceRules }) => ipc.sourceSave(id, def),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });
}

export function useDeleteSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.sourceDelete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });
}

export function useSourceSearch() {
  return useMutation({
    mutationFn: ({ sourceId, keyword }: { sourceId: string; keyword: string }) =>
      ipc.sourceSearch(sourceId, keyword),
  });
}

/** Downloads one book, tracking live chapter progress. */
export function useSourceDownload() {
  const [progress, setProgress] = useState<SourceProgress | null>(null);

  useTauriEvent(onSourceProgress, setProgress);

  const download = useMutation({
    mutationFn: ({ sourceId, bookUrl }: { sourceId: string; bookUrl: string }) =>
      ipc.sourceDownload(sourceId, bookUrl),
    meta: { silent: true },
    onSettled: () => setProgress(null),
  });

  return { download, progress };
}
