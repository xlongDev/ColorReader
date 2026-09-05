import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { SyncConfig } from "@/types/ipc";

/** Browser dev mode has no backend; the settings form still needs a shape. */
const OFFLINE_CONFIG: SyncConfig = { url: "", username: "", password: "" };

/** Persisted WebDAV config. `staleTime: Infinity` — it only changes here. */
export function useSyncConfig() {
  return useQuery<SyncConfig>({
    queryKey: ["sync", "config"],
    queryFn: () => (isDesktopRuntime ? ipc.syncGetConfig() : Promise.resolve(OFFLINE_CONFIG)),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Saves the config; the query refreshes so the form shows the stored form. */
export function useSaveSyncConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: SyncConfig) => ipc.syncSetConfig(config),
    onSettled: (saved) => {
      queryClient.setQueryData(["sync", "config"], saved);
    },
  });
}

/** Proves the server is reachable and authorized. Does not persist. */
export function useTestSyncConfig() {
  return useMutation({ mutationFn: (config: SyncConfig) => ipc.syncTest(config) });
}

/** Runs one full sync cycle; the shelf refreshes with any downloaded progress. */
export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: SyncConfig) => ipc.syncNow(config),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
}
