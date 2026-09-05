import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onGraphProgress } from "@/lib/ipc";
import type { GraphProgress } from "@/types/ipc";

/** Graph status for one book. Refreshed after every build. */
export function useGraphStatus(bookId: string) {
  return useQuery({
    queryKey: ["graph", "status", bookId],
    queryFn: () => {
      if (!isDesktopRuntime) {
        return Promise.resolve({ entities: 0, relations: 0, model: "" });
      }
      return ipc.graphStatus(bookId);
    },
    staleTime: 5_000,
  });
}

/** All entities, or the relations of one selected entity. */
export function useGraphQuery(bookId: string, entity: string | null) {
  return useQuery({
    queryKey: ["graph", "view", bookId, entity],
    queryFn: () => {
      if (!isDesktopRuntime) {
        return Promise.resolve({ entities: [], relations: [] });
      }
      return ipc.graphQuery(bookId, entity);
    },
    staleTime: 5_000,
  });
}

/** Rebuilds one book's graph, tracking live chapter progress. */
export function useGraphBuild(bookId: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<GraphProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onGraphProgress((next) => setProgress(next)).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  const build = useMutation({
    mutationFn: () => ipc.graphBuild(bookId),
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  return { build, progress };
}
