import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as bundled from "@/features/reader/bundledFont";
import { useBundledFont } from "@/features/reader/useBundledFont";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBundledFont", () => {
  it("answers other keys unchanged, and synchronously", () => {
    const load = vi.spyOn(bundled, "loadBundledFontCss");
    for (const key of ["book", "system", "song", "kai", "hei", "custom:7f1c"]) {
      const { result } = renderHook(() => useBundledFont(key));
      expect(result.current, key).toBe(key);
    }
    // Nothing outside 霞鹜文楷 pays for the sheet — that is the whole point of
    // making it lazy, so it has to be pinned rather than assumed.
    expect(load).not.toHaveBeenCalled();
  });

  it("reports 楷体 while the sheet is still being fetched", async () => {
    // Rendering the bundled key before the rules exist would read the CSSOM,
    // find nothing, and style the section in… the system sans (that is what
    // `resolveFont(null)` means on a prose path). 楷体 is the family the
    // 霞鹜文楷 stack falls through to, so the frame looks like the finished
    // thing rather than like a change.
    const gate: { open?: () => void } = {};
    const pending = new Promise<void>((done) => {
      gate.open = done;
    });
    vi.spyOn(bundled, "loadBundledFontCss").mockReturnValue(pending);

    const { result } = renderHook(() => useBundledFont("lxgw"));
    expect(result.current).toBe("kai");
    gate.open?.();
    await waitFor(() => expect(result.current).toBe("lxgw"));
  });

  it("loads the sheet for a reader who picks the font after opening the book", async () => {
    // 🔴 The regression this guards. Every other case here renders with the
    // bundled key on the *first* render, which is not how a reader gets here:
    // the sheet is fetched when they pick it, from a hook that mounted with some
    // other font and has been running ever since. A state initialised from the
    // first render marks the sheet loaded before it was ever asked for, the
    // effect returns on its own guard, and the reader picks 霞鹜文楷 and watches
    // 楷体 with nothing thrown and nothing logged.
    const load = vi.spyOn(bundled, "loadBundledFontCss").mockResolvedValue();
    const { result, rerender } = renderHook(({ key }) => useBundledFont(key), {
      initialProps: { key: "book" },
    });
    expect(load).not.toHaveBeenCalled();

    rerender({ key: "lxgw" });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current).toBe("lxgw"));
  });

  it("asks for the sheet once, however many times the effect re-runs", async () => {
    const load = vi.spyOn(bundled, "loadBundledFontCss").mockResolvedValue();
    const { rerender } = renderHook(({ key }) => useBundledFont(key), {
      initialProps: { key: "lxgw" },
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender({ key: "lxgw" });
    rerender({ key: "lxgw" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("says so when the sheet cannot be fetched, and does not retry forever", async () => {
    // A reader who picked 霞鹜文楷 gets 楷体 either way — that is what the
    // stack falls through to — but the failure is not silent, and it is not
    // re-attempted on every re-render.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = vi.spyOn(bundled, "loadBundledFontCss").mockRejectedValue(new Error("no sheet"));

    const { rerender } = renderHook(({ key }) => useBundledFont(key), {
      initialProps: { key: "book" },
    });
    rerender({ key: "lxgw" });
    await waitFor(() => expect(warn).toHaveBeenCalled());
    rerender({ key: "lxgw" });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("the web build's stand-in", () => {
  it("says the face does not exist, and loading it does nothing", async () => {
    // The other half of the desktop module, aliased in for `PAGES_BASE`. Both
    // facts are asserted here because this file is the *only* thing that keeps
    // the two builds from drifting: the web build's answer lives in a module no
    // desktop test loads.
    const web = await import("@/features/reader/no-bundled-font");
    expect(web.BUNDLED_FONT_AVAILABLE).toBe(false);
    expect(bundled.BUNDLED_FONT_AVAILABLE).toBe(true);
    await expect(web.loadBundledFontCss()).resolves.toBeUndefined();
  });
});
