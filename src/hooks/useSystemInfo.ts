import { useQuery } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { SystemInfo } from "@/types/ipc";

/**
 * Live system info from Rust, with a transparent "browser dev" fallback so the
 * About panel is meaningful when the renderer is run outside Tauri.
 */
export function useSystemInfo() {
  return useQuery<SystemInfo>({
    queryKey: ["system.info"],
    queryFn: async () => {
      if (!isDesktopRuntime) {
        return {
          appName: "colorreader",
          appVersion: "dev",
          os: navigator.platform || "browser",
          arch: "wasm",
          webview: null,
          dataDir: "(browser dev mode)",
          uptimeMs: 0,
        };
      }
      return ipc.systemInfo();
    },
    staleTime: 60_000,
  });
}
