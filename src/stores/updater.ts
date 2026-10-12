import { create } from "zustand";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { isDesktopRuntime } from "@/lib/ipc";

/**
 * What the update row is showing.
 *
 * "Already current" is its own state rather than a quiet flavour of success:
 * it is the outcome of almost every check, and a reader who pressed the button
 * needs to see that something happened. A failed check is separate again, so
 * it can be coloured and can say what went wrong.
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
 * The release handle between the check and the install.
 *
 * Module scope, not state: nothing renders it, and keeping it in state would
 * only let the two actions disagree about which release they are working on.
 */
let pending: Update | null = null;

/**
 * The whole update flow, shared by both surfaces that ask.
 *
 * A store rather than a hook's local state because there are now two writers:
 * the 设置 row (the reader pressed 检查更新) and the shell's `UpdateBanner`
 * (one delayed check after launch — see F2 in `docs/suggestions-2026-10-12.md`),
 * plus two readers that must agree on what is happening. As a hook each
 * consumer owned its own state, so the row could say 正在下载 while the banner
 * still offered the same release for installing.
 *
 * Both actions the reader takes are still manual. The launch check only ever
 * *finds* a release — an update that arrives silently is worse than one the
 * reader asked for, and the banner it raises is dismissible.
 */
interface UpdaterStore {
  state: UpdateState;
  checkForUpdate: () => Promise<void>;
  installAndRestart: () => Promise<void>;
}

export const useUpdater = create<UpdaterStore>()((set) => ({
  state: { status: "idle" },

  checkForUpdate: async () => {
    if (!isDesktopRuntime) {
      // Browser dev mode has no shell and no update channel. Saying so beats an
      // `invoke` rejection that names a plugin the reader has never heard of.
      set({ state: { status: "failed", message: "浏览器预览模式没有更新通道，请在应用内检查。" } });
      return;
    }
    set({ state: { status: "checking" } });
    try {
      const update = await check();
      pending = update;
      set({
        state: update ? { status: "available", version: update.version } : { status: "current" },
      });
    } catch (error) {
      pending = null;
      set({ state: { status: "failed", message: describe(error) } });
    }
  },

  installAndRestart: async () => {
    if (!pending) return;
    set({ state: { status: "downloading", percent: null } });
    try {
      let received = 0;
      let total = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          return;
        }
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          // With no content length there is no honest percentage, so the row
          // stays indefinite instead of inventing one.
          set({
            state: {
              status: "downloading",
              percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
            },
          });
        }
      });
      // macOS and Linux swap the bundle underneath the running process, so the
      // new version only takes effect after a restart.
      await relaunch();
    } catch (error) {
      set({ state: { status: "failed", message: describe(error) } });
    }
  },
}));
