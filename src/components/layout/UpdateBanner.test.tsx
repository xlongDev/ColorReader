import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateBanner } from "./UpdateBanner";
import { useUpdater } from "@/stores/updater";

const downloadAndInstall = vi.fn();
let desktop = true;
const check = vi.fn();

vi.mock("@/lib/ipc", () => ({
  get isDesktopRuntime() {
    return desktop;
  },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => check(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

/**
 * What the bar shows, on the real clock.
 *
 * The store is driven through its own actions rather than through the
 * component's launch-check timer, so no test here needs a fake clock — and
 * none of them can use one: motion's global frame loop does not survive a fake
 * one, and a bar that never finishes leaving would fail the dismissal test
 * below. When the launch check *happens* is pinned in
 * `UpdateBanner.check.test.tsx`, the one place that needs a fake clock.
 */
beforeEach(() => {
  check.mockReset();
  downloadAndInstall.mockReset();
  desktop = true;
  // The store is a module singleton — without this reset, a release found by
  // one test would still be on offer in the next.
  useUpdater.setState({ state: { status: "idle" } });
});

afterEach(() => {
  useUpdater.setState({ state: { status: "idle" } });
});

/** Run a check the way the shell's launch check would, and let it settle. */
async function checkOnce() {
  await act(async () => {
    await useUpdater.getState().checkForUpdate();
  });
}

describe("UpdateBanner", () => {
  it("announces a release that is ready", async () => {
    check.mockResolvedValue({ version: "9.9.9" });
    render(<UpdateBanner />);
    await checkOnce();

    expect(screen.getByText("9.9.9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装并重启" })).toBeInTheDocument();
  });

  it("says nothing when the reader is already up to date", async () => {
    check.mockResolvedValue(null);
    render(<UpdateBanner />);
    await checkOnce();

    expect(document.querySelector("[data-update-banner]")).toBeNull();
  });

  it("says nothing when the check failed — nobody asked for it", async () => {
    check.mockRejectedValue(new Error("network down"));
    render(<UpdateBanner />);
    await checkOnce();

    expect(document.querySelector("[data-update-banner]")).toBeNull();
  });

  it("says nothing in the browser, where there is no update channel", async () => {
    desktop = false;
    render(<UpdateBanner />);
    await checkOnce();

    expect(check).not.toHaveBeenCalled();
    expect(document.querySelector("[data-update-banner]")).toBeNull();
  });

  it("shows the download once the install starts", async () => {
    // A download that never settles, so the bar is observed mid-flight
    // rather than after a relaunch that does not happen in a test.
    downloadAndInstall.mockReturnValue(new Promise<void>(() => {}));
    check.mockResolvedValue({ version: "9.9.9", downloadAndInstall });
    render(<UpdateBanner />);
    await checkOnce();

    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));

    expect(await screen.findByText("正在下载更新…")).toBeInTheDocument();
    // The install action is the row's now; offering it twice would let two
    // downloads race on the same release.
    expect(screen.queryByRole("button", { name: "安装并重启" })).toBeNull();
  });

  it("goes away when the reader dismisses it", async () => {
    check.mockResolvedValue({ version: "9.9.9" });
    render(<UpdateBanner />);
    await checkOnce();

    fireEvent.click(screen.getByRole("button", { name: "关闭更新提示" }));

    // The bar leaves through its exit animation, so it is gone once the
    // animation has run rather than on the click itself.
    await waitFor(() => expect(document.querySelector("[data-update-banner]")).toBeNull(), {
      timeout: 3_000,
    });
  });
});
