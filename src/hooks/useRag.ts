import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onRagProgress } from "@/lib/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { RagProgress } from "@/types/ipc";

/** Index status for one book. Refreshed after every index build. */
export function useRagStatus(bookId: string) {
  return useQuery({
    queryKey: ["rag", "status", bookId],
    queryFn: () => {
      if (!isDesktopRuntime) {
        return Promise.resolve({ bookChunks: 0, libraryChunks: 0, embeddingModel: "" });
      }
      return ipc.ragStatus(bookId);
    },
    staleTime: 5_000,
  });
}

/** Rebuilds one book's embedding index, tracking live progress. */
export function useIndexBook(bookId: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RagProgress | null>(null);

  useTauriEvent(onRagProgress, setProgress);

  const build = useMutation({
    mutationFn: () => ipc.ragIndexBook(bookId),
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["rag", "status"] });
    },
  });

  return { build, progress };
}
