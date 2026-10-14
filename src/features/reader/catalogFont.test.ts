import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogFontById } from "@/lib/fontCatalog";
import {
  adoptCatalogFont,
  downloadCatalogFont,
  isCatalogAdopted,
  removeCatalogFont,
} from "./catalogFont";

const noto = catalogFontById("noto-serif-sc")!;
const lxgw = catalogFontById("lxgw")!;

/**
 * One of the real sheets the manifest pins.
 *
 * A synthetic stylesheet would fail the catalogue's own hash check, so the
 * success path has to fetch the bytes the hashes were computed from — these
 * are the same files the e2e suite serves for the click-through.
 *
 * Resolved through `node:path` rather than `new URL(…, import.meta.url)`: the
 * global `URL` under jsdom resolves relatives against `http://localhost:3000`,
 * so the URL form answers an `http:` href that `fileURLToPath` refuses.
 */
const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../e2e/fixtures/font-catalog",
);

function fixture(name: string): ArrayBuffer {
  const buffer = readFileSync(resolve(FIXTURES, name));
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

beforeEach(() => {
  // jsdom ships no SubtleCrypto; node's real one keeps the hash assertions
  // from being vacuous.
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  for (const element of document.querySelectorAll('[id^="catalog-font-"]')) element.remove();
  vi.unstubAllGlobals();
});

/** A `fetch` that answers from a url → bytes table and 404s everything else. */
function stubFetch(entries: [string, ArrayBuffer | "error"][]): void {
  const table = new Map<string, ArrayBuffer | "error">(entries);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const bytes = table.get(url);
      if (bytes === undefined)
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      if (bytes === "error") throw new Error("network down");
      return { ok: true, arrayBuffer: async () => bytes };
    }),
  );
}

describe("downloadCatalogFont", () => {
  it("adopts every sheet, rewritten for an adopted document", async () => {
    stubFetch([
      [noto.sheets[0]!.sources[0]!, fixture("noto-serif-sc-400.css")],
      [noto.sheets[1]!.sources[0]!, fixture("noto-serif-sc-700.css")],
    ]);

    await expect(downloadCatalogFont(noto)).resolves.toBe(105_678 * 2);

    const style = document.getElementById("catalog-font-noto-serif-sc");
    expect(style).not.toBeNull();
    // Subset URLs are absolute — an adopted <style> has no base to resolve
    // the sheets' relative `./files/…` against.
    expect(style!.textContent).toContain(
      'url("https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.1/files/noto-serif-sc',
    );
    expect(style!.textContent).not.toContain("./files/");
    // The hold-back rewrite, same as the build layer applies to the bundled
    // sheet: the reader who just picked the font should not watch it swap in.
    expect(style!.textContent).not.toContain("font-display: swap");
    expect(style!.textContent).toContain("font-display: block");
    expect(isCatalogAdopted(noto.id)).toBe(true);
  });

  it("refuses a sheet that does not hash to the pinned value, and adopts nothing", async () => {
    // What a compromised or substituted CDN copy looks like from here. The
    // refusal is the only thing standing between that and the app silently
    // rendering someone else's glyphs.
    stubFetch([
      [
        lxgw.sheets[0]!.sources[0]!,
        new TextEncoder().encode("not the pinned sheet").buffer as ArrayBuffer,
      ],
      [lxgw.sheets[1]!.sources[0]!, fixture("lxgw-bold.css")],
    ]);

    await expect(downloadCatalogFont(lxgw)).rejects.toThrow(/校验失败/);
    expect(isCatalogAdopted(lxgw.id)).toBe(false);
    expect(document.getElementById("catalog-font-lxgw")).toBeNull();
  });

  it("asks the next source when the first one does not answer", async () => {
    stubFetch([
      [lxgw.sheets[0]!.sources[0]!, "error"],
      [lxgw.sheets[1]!.sources[0]!, "error"],
      [lxgw.sheets[0]!.sources[1]!, fixture("lxgw-regular.css")],
      [lxgw.sheets[1]!.sources[1]!, fixture("lxgw-bold.css")],
    ]);

    await expect(downloadCatalogFont(lxgw)).resolves.toBe(105_359 + 105_068);
    expect(isCatalogAdopted(lxgw.id)).toBe(true);
  });

  it("does nothing when the face is already adopted", async () => {
    adoptCatalogFont(lxgw.id, "/* already here */");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(downloadCatalogFont(lxgw)).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The adopted rules survive untouched.
    expect(document.getElementById("catalog-font-lxgw")!.textContent).toBe("/* already here */");
  });
});

describe("removal", () => {
  it("takes the adopted face out of the document", () => {
    adoptCatalogFont(noto.id, "@font-face {}");
    expect(isCatalogAdopted(noto.id)).toBe(true);
    removeCatalogFont(noto.id);
    expect(isCatalogAdopted(noto.id)).toBe(false);
    expect(document.getElementById("catalog-font-noto-serif-sc")).toBeNull();
  });
});
