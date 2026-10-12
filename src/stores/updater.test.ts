import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUpdater } from "./updater";

// The runtime half of the updater is Tauri's. Mocked as controllable
// handles so the state machine can be driven without a shell —
// `isDesktopRuntime` as a getter because one file tests both halves.
let desktop = true;
const check = vi.fn();
const downloadAndInstall = vi.fn();
const relaunch = vi.fn();

vi.mock("@/lib/ipc", () => ({
  get isDesktopRuntime() {
    return desktop;
  },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => check(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));

beforeEach(() => {
  check.mockReset();
  downloadAndInstall.mockReset();
  relaunch.mockReset();
  desktop = true;
  useUpdater.setState({ state: { status: "idle" } });
});

describe("useUpdater.checkForUpdate", () => {
  it("reports the version of a release that is ready", async () => {
    check.mockResolvedValue({ version: "9.9.9" });

    await useUpdater.getState().checkForUpdate();

    expect(useUpdater.getState().state).toEqual({ status: "available", version: "9.9.9" });
  });

  it("reports being current when there is no newer release", async () => {
    check.mockResolvedValue(null);

    await useUpdater.getState().checkForUpdate();

    expect(useUpdater.getState().state).toEqual({ status: "current" });
  });

  it("keeps the reason a failed check failed", async () => {
    check.mockRejectedValue(new Error("network down"));

    await useUpdater.getState().checkForUpdate();

    expect(useUpdater.getState().state).toEqual({ status: "failed", message: "network down" });
  });

  it("says so rather than throwing in the browser, where there is no channel", async () => {
    desktop = false;

    await useUpdater.getState().checkForUpdate();

    expect(check).not.toHaveBeenCalled();
    expect(useUpdater.getState().state).toEqual({
      status: "failed",
      message: "浏览器预览模式没有更新通道，请在应用内检查。",
    });
  });
});

describe("useUpdater.installAndRestart", () => {
  beforeEach(async () => {
    check.mockResolvedValue({ version: "9.9.9", downloadAndInstall });
    await useUpdater.getState().checkForUpdate();
  });

  it("reports an honest percentage while downloading, then restarts", async () => {
    downloadAndInstall.mockImplementation(
      (
        onEvent: (event: {
          event: string;
          data: { contentLength?: number; chunkLength?: number };
        }) => void,
      ) => {
        onEvent({ event: "Started", data: { contentLength: 100 } });
        onEvent({ event: "Progress", data: { chunkLength: 50 } });
        return Promise.resolve();
      },
    );

    await useUpdater.getState().installAndRestart();

    expect(relaunch).toHaveBeenCalledOnce();
    // The install ends in a relaunch, so the resting state is the one the
    // download was last reported in — the app is gone before it can be redrawn.
    expect(useUpdater.getState().state).toEqual({ status: "downloading", percent: 50 });
  });

  it("stays indefinite when the release reports no content length", async () => {
    downloadAndInstall.mockResolvedValue(undefined);

    await useUpdater.getState().installAndRestart();

    expect(useUpdater.getState().state).toEqual({ status: "downloading", percent: null });
  });

  it("keeps the reason a failed install failed", async () => {
    downloadAndInstall.mockRejectedValue(new Error("disk full"));

    await useUpdater.getState().installAndRestart();

    expect(useUpdater.getState().state).toEqual({ status: "failed", message: "disk full" });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("does nothing without a release that was found", async () => {
    check.mockResolvedValue(null);
    await useUpdater.getState().checkForUpdate();
    downloadAndInstall.mockClear();

    await useUpdater.getState().installAndRestart();

    expect(downloadAndInstall).not.toHaveBeenCalled();
  });
});
