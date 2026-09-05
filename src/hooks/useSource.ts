import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onSourceProgress } from "@/lib/ipc";
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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onSourceProgress((next) => setProgress(next)).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  const download = useMutation({
    mutationFn: ({ sourceId, bookUrl }: { sourceId: string; bookUrl: string }) =>
      ipc.sourceDownload(sourceId, bookUrl),
    onSettled: () => setProgress(null),
  });

  return { download, progress };
}
