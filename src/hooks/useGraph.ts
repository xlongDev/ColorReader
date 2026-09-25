import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc, onGraphProgress } from "@/lib/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { GraphProgress } from "@/types/ipc";

/** Graph status for one book. Refreshed after every build. */
export function useGraphStatus(bookId: string) {
  return useQuery({
    queryKey: ["graph", "status", bookId],
    queryFn: () => {
      // The graph lives in the desktop's own store; the browser has no copy,
      // and this is what it reports rather than pretending to have asked.
      return desktopQuery({ entities: 0, relations: 0, model: "" }, () =>
        ipc.graphStatus(bookId),
      )();
    },
    staleTime: 5_000,
  });
}

/** All entities, or the relations of one selected entity. */
export function useGraphQuery(bookId: string, entity: string | null) {
  return useQuery({
    queryKey: ["graph", "view", bookId, entity],
    queryFn: () => {
      return desktopQuery({ entities: [], relations: [] }, () => ipc.graphQuery(bookId, entity))();
    },
    staleTime: 5_000,
  });
}

/** Rebuilds one book's graph, tracking live chapter progress. */
export function useGraphBuild(bookId: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<GraphProgress | null>(null);

  useTauriEvent(onGraphProgress, setProgress);

  const build = useMutation({
    mutationFn: () => ipc.graphBuild(bookId),
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  return { build, progress };
}
