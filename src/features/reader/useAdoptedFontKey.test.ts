import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as catalog from "@/features/reader/catalogFont";
import { useAdoptedFontKey } from "@/features/reader/useAdoptedFontKey";

afterEach(() => {
  vi.restoreAllMocks();
  catalog.removeCatalogFont("noto-serif-sc");
});

describe("useAdoptedFontKey", () => {
  it("renders the fallback family while the sheets are being adopted", async () => {
    // Rendering the key before the rules exist would read the CSSOM, find
    // nothing, and style the section in the system 宋体. Noto Serif SC falls
    // through to the 宋体 stack, so the frame looks like the finished thing
    // rather than like a change.
    const gate: { open?: () => void } = {};
    const pending = new Promise<void>((done) => {
      gate.open = done;
    });
    vi.spyOn(catalog, "ensureCatalogAdopted").mockReturnValue(pending);

    const { result } = renderHook(() => useAdoptedFontKey("catalog:noto-serif-sc"));
    expect(result.current).toBe("song");
    gate.open?.();
    await waitFor(() => expect(result.current).toBe("catalog:noto-serif-sc"));
  });

  it("loads the sheets for a reader who picks the font after opening the book", async () => {
    // 🔴 The regression this guards. Every other case here renders with the
    // catalogue key on the *first* render, which is not how a reader gets here:
    // the sheets are fetched when they pick it, from a hook that mounted with
    // some other font and has been running ever since. A state initialised from
    // the first render marks the sheet loaded before it was ever asked for, the
    // effect returns on its own guard, and the reader picks 霞鹜文楷 and watches
    // 楷体 with nothing thrown and nothing logged.
    const adopt = vi.spyOn(catalog, "ensureCatalogAdopted").mockResolvedValue();
    const { result, rerender } = renderHook(({ key }) => useAdoptedFontKey(key), {
      initialProps: { key: "book" },
    });
    expect(adopt).not.toHaveBeenCalled();

    rerender({ key: "catalog:noto-serif-sc" });
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current).toBe("catalog:noto-serif-sc"));
  });

  it("asks for the sheets once, however many times the effect re-runs", async () => {
    const adopt = vi.spyOn(catalog, "ensureCatalogAdopted").mockResolvedValue();
    const { rerender } = renderHook(({ key }) => useAdoptedFontKey(key), {
      initialProps: { key: "catalog:noto-serif-sc" },
    });
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    rerender({ key: "catalog:noto-serif-sc" });
    rerender({ key: "catalog:noto-serif-sc" });
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("leaves a font that is already adopted alone", () => {
    // The settings page installs a catalogue font; the reader then mounts with
    // that key and must not fetch the sheets a second time.
    catalog.adoptCatalogFont("noto-serif-sc", "@font-face {}");
    const adopt = vi.spyOn(catalog, "ensureCatalogAdopted");

    const { result } = renderHook(() => useAdoptedFontKey("catalog:noto-serif-sc"));
    expect(result.current).toBe("catalog:noto-serif-sc");
    expect(adopt).not.toHaveBeenCalled();
  });

  it("says so when the sheets cannot be fetched, and does not retry forever", async () => {
    // A reader who picked the font gets 宋体 either way — that is what the
    // stack falls through to — but the failure is not silent, and it is not
    // re-attempted on every re-render.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adopt = vi
      .spyOn(catalog, "ensureCatalogAdopted")
      .mockRejectedValue(new Error("no sheet"));

    const { rerender } = renderHook(({ key }) => useAdoptedFontKey(key), {
      initialProps: { key: "book" },
    });
    rerender({ key: "catalog:noto-serif-sc" });
    await waitFor(() => expect(warn).toHaveBeenCalled());
    rerender({ key: "catalog:noto-serif-sc" });
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("answers every other key unchanged, and synchronously", () => {
    const adopt = vi.spyOn(catalog, "ensureCatalogAdopted");
    // `lxgw` is in this list on purpose: it was the dev-only bundled key, and
    // the hook must treat it as a key it knows nothing about rather than
    // resurrect a face no build carries any more.
    for (const key of ["book", "system", "song", "kai", "hei", "custom:7f1c", "lxgw"]) {
      const { result } = renderHook(() => useAdoptedFontKey(key));
      expect(result.current, key).toBe(key);
    }
    expect(adopt).not.toHaveBeenCalled();
  });
});
