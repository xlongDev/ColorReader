import { render, screen, act } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { UpdateBanner } from "./UpdateBanner";
import { useChrome } from "@/stores/chrome";
import { useUpdater } from "@/stores/updater";

/**
 * When the launch check happens — the one behaviour of this component that
 * needs a fake clock, and the reason it lives in its own file.
 *
 * Motion's frame loop is global and does not survive a fake one: run it under
 * fake timers and every later animation in the same file inherits a timestamp
 * from a clock that no longer exists. Animations are switched off here with
 * the app's own `MotionConfig` (a reader with `prefers-reduced-motion` sees
 * exactly this), and nothing in this file waits for one to finish.
 */
const CHECK_DELAY_MS = 8_000;

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

function mount() {
  vi.useFakeTimers();
  render(
    <MotionConfig reducedMotion="always">
      <UpdateBanner />
    </MotionConfig>,
  );
}

beforeEach(() => {
  check.mockReset();
  desktop = true;
  useUpdater.setState({ state: { status: "idle" } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateBanner launch check", () => {
  it("waits rather than competing with the first paint", async () => {
    mount();

    expect(document.querySelector("[data-update-banner]")).toBeNull();
    expect(check).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS - 1);
    });
    expect(check).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it("checks once per launch, not on a timer", async () => {
    mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS * 3);
    });

    expect(check).toHaveBeenCalledOnce();
  });

  it("does not check at all in the browser", async () => {
    desktop = false;
    mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS * 2);
    });

    expect(check).not.toHaveBeenCalled();
    expect(document.querySelector("[data-update-banner]")).toBeNull();
  });

  it("puts what the delayed check found on screen", async () => {
    check.mockResolvedValue({ version: "9.9.9" });
    mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    });

    expect(screen.getByText("9.9.9")).toBeInTheDocument();
  });

  it("keeps out of the immersive reader", async () => {
    useChrome.setState({ readerFullscreen: true });
    check.mockResolvedValue({ version: "9.9.9" });
    mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    });

    // The release was found — the state says so — but the reading surface is
    // fullscreen, so nothing is drawn over it.
    expect(useUpdater.getState().state).toEqual({ status: "available", version: "9.9.9" });
    expect(document.querySelector("[data-update-banner]")).toBeNull();
  });
});
