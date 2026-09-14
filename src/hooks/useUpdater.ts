import { useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { isDesktopRuntime } from "@/lib/ipc";

/**
 * What the update row is showing.
 *
 * "Already current" is its own state rather than a quiet flavour of success:
 * it is the outcome of almost every check, and a reader who pressed the button
 * needs to see that something happened. A failed check is separate again, so it
 * can be coloured and can say what went wrong.
 */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; version: string }
  | { status: "downloading"; percent: number | null }
  | { status: "failed"; message: string };

/** An unknown throw still has to land somewhere a reader can read. */
function describe(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return error;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "更新失败，请稍后重试。";
}

/**
 * The whole update flow as the settings row needs it: check, then install and
 * restart.
 *
 * The `Update` handle between those two steps lives in a ref rather than in
 * state: nothing renders it, and keeping it in state would only let the two
 * actions disagree about which release they are working on.
 *
 * Both actions are manual. Checking on launch would need a surface to announce
 * itself (a banner or a badge) that does not exist yet, and an update that
 * arrives silently is worse than one the reader asked for.
 */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const pending = useRef<Update | null>(null);

  const checkForUpdate = async () => {
    if (!isDesktopRuntime) {
      // Browser dev mode has no shell and no update channel. Saying so beats an
      // `invoke` rejection that names a plugin the reader has never heard of.
      setState({ status: "failed", message: "浏览器预览模式没有更新通道，请在应用内检查。" });
      return;
    }
    setState({ status: "checking" });
    try {
      const update = await check();
      pending.current = update;
      setState(update ? { status: "available", version: update.version } : { status: "current" });
    } catch (error) {
      pending.current = null;
      setState({ status: "failed", message: describe(error) });
    }
  };

  const installAndRestart = async () => {
    const update = pending.current;
    if (!update) return;
    setState({ status: "downloading", percent: null });
    try {
      let received = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          return;
        }
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          // With no content length there is no honest percentage, so the row
          // stays indefinite instead of inventing one.
          setState({
            status: "downloading",
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
          });
        }
      });
      // macOS and Linux swap the bundle underneath the running process, so the
      // new version only takes effect after a restart.
      await relaunch();
    } catch (error) {
      setState({ status: "failed", message: describe(error) });
    }
  };

  return { state, checkForUpdate, installAndRestart };
}
