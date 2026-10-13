import { useQuery } from "@tanstack/react-query";

import { desktopQuery, ipc } from "@/lib/ipc";
import type { SecretsStatus, SystemInfo } from "@/types/ipc";

/** What the About panel shows when there is no Rust side to ask. It says
 *  `browser` rather than inventing a version, so a reader reading it knows it
 *  is the browser build's own panel and not a stale one. */
const IN_BROWSER: SystemInfo = {
  appName: "colorreader",
  appVersion: "dev",
  os: "browser",
  arch: "wasm",
  webview: null,
  dataDir: "（浏览器：数据在 IndexedDB 里）",
  uptimeMs: 0,
};

/**
 * Live system info from Rust — or, in the browser, the row above. This build
 * has no `os`, no `arch` and no data directory to name, so it says so instead
 * of answering with the desktop's defaults.
 */
export function useSystemInfo() {
  return useQuery<SystemInfo>({
    queryKey: ["system.info"],
    queryFn: desktopQuery(IN_BROWSER, () => ipc.systemInfo()),
    staleTime: 60_000,
  });
}

/**
 * Whether this machine can seal the credentials in the database.
 *
 * Asked once and kept: it is a fact about the machine, not about the library,
 * and nothing in the app changes it. It cannot fail — "the credential store is
 * unusable" is the answer, not an error — so there is no error branch to write
 * and no way for a broken keychain to take the settings page down with it.
 */
export function useSecretsStatus() {
  return useQuery<SecretsStatus>({
    queryKey: ["system", "secrets"],
    queryFn: () => ipc.secretsStatus(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
