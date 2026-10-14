import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogFontById } from "@/lib/fontCatalog";
import {
  adoptCatalogFont,
  downloadCatalogFont,
  forgetCatalogFonts,
  isCatalogAdopted,
  removeCatalogFont,
} from "./catalogFont";

const noto = catalogFontById("noto-serif-sc")!;
const lxgw = catalogFontById("lxgw")!;

/**
 * The `localStorage` key the adopted sheets live under, spelled out rather than
 * imported.
 *
 * It is a compatibility surface, not an implementation detail: renaming it
 * silently discards every sheet on every reader's machine — the fonts all
 * re-download on the next launch, and nobody is told. A test that goes red when
 * someone renames it is the whole point, so this one deliberately does not
 * follow the constant.
 */
const SHEET_STORE = "colorreader.catalogFontSheets";

/** What a restart looks like from here: the document is new, so the adopted
 *  `<style>` is gone, and whatever the previous session kept is all that is
 *  left of the font. */
function restartDocument(): void {
  for (const element of document.querySelectorAll('[id^="catalog-font-"]')) element.remove();
}

/** The sheet the app kept for a font — what the next launch installs from. */
function keptCss(id: string): string {
  const store = JSON.parse(localStorage.getItem(SHEET_STORE)!) as Record<string, { css: string }>;
  return store[id]!.css;
}

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

describe("the kept sheet", () => {
  it("keeps the adopted sheet, and installs from it with the network gone", async () => {
    // 🔴 The bug this exists for: the sheet used to live only in the document.
    // A font the reader had installed and been reading in vanished whole on the
    // next launch without a network — every glyph of it, not a subset — and
    // there was nothing on screen to say why.
    stubFetch([
      [lxgw.sheets[0]!.sources[0]!, fixture("lxgw-regular.css")],
      [lxgw.sheets[1]!.sources[0]!, fixture("lxgw-bold.css")],
    ]);
    await downloadCatalogFont(lxgw);

    const kept = keptCss(lxgw.id);
    expect(kept).toContain("font-display: block");
    expect(kept).toContain("https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/files/");

    restartDocument();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(downloadCatalogFont(lxgw)).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.getElementById("catalog-font-lxgw")!.textContent).toBe(kept);
  });

  it("re-fetches a kept sheet this build would no longer accept", async () => {
    // What a package bump or a corrected pin looks like from here: the copy on
    // disk was built from bytes this build refuses. Adopting it anyway would be
    // the hash check's whole point, quietly skipped — the app rendering from
    // bytes it would not download.
    localStorage.setItem(
      SHEET_STORE,
      JSON.stringify({
        [lxgw.id]: { fingerprint: "an older pin", css: "@font-face { /* stale */ }" },
      }),
    );
    stubFetch([
      [lxgw.sheets[0]!.sources[0]!, fixture("lxgw-regular.css")],
      [lxgw.sheets[1]!.sources[0]!, fixture("lxgw-bold.css")],
    ]);

    await downloadCatalogFont(lxgw);

    const adopted = document.getElementById("catalog-font-lxgw")!.textContent!;
    expect(adopted).not.toContain("stale");
    expect(adopted).toContain("font-display: block");
    // …and the stale copy is replaced, not left beside the good one.
    expect(localStorage.getItem(SHEET_STORE)).not.toContain("an older pin");
  });

  it("re-fetches when a pin moves, not only when the id is unknown", async () => {
    // The fingerprint is every sheet's hash, so a bump to the bold face alone
    // has to invalidate the copy — a fingerprint over the first sheet only
    // would leave this build rendering bold from bytes it would refuse to
    // download, which is the one thing the check exists to prevent.
    stubFetch([
      [lxgw.sheets[0]!.sources[0]!, fixture("lxgw-regular.css")],
      [lxgw.sheets[1]!.sources[0]!, fixture("lxgw-bold.css")],
    ]);
    await downloadCatalogFont(lxgw);
    restartDocument();

    // A fresh stub, so "did it go to the network again" is a question about
    // this install rather than about the first one.
    stubFetch([
      [lxgw.sheets[0]!.sources[0]!, fixture("lxgw-regular.css")],
      [lxgw.sheets[1]!.sources[0]!, fixture("lxgw-bold.css")],
    ]);
    const fetchSpy = vi.mocked(globalThis.fetch);
    const bumped = {
      ...lxgw,
      sheets: [lxgw.sheets[0]!, { ...lxgw.sheets[1]!, sha256: "0".repeat(64) }],
    };

    // The fixtures are the *old* bytes, so the bumped pin refuses them — which
    // is what a CDN still serving the previous file looks like. The assertion
    // that carries this test is the one below: the app went and asked, rather
    // than adopting what it had kept.
    await expect(downloadCatalogFont(bumped)).rejects.toThrow(/校验失败/);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it.each([
    ["not JSON at all", "{ this is not json"],
    ["JSON of the wrong type", '"a string"'],
    ["JSON null", "null"],
    // The right JSON, the wrong shape: a `css` with no fingerprint is not
    // something this version wrote, and must not be trusted as one.
    ["an entry with no fingerprint", '{"lxgw":{"css":"@font-face { /* from nowhere */ }"}}'],
  ])("installs anyway when the store holds %s", async (_shape, corrupt) => {
    // A store is the app's own file on disk, and a file can be truncated by a
    // crash, hand-edited, or left over from a build that wrote another shape.
    // None of that is a reason for 安装 to fail: the sheets are still there to
    // be fetched.
    localStorage.setItem(SHEET_STORE, corrupt);
    stubFetch([
      [lxgw.sheets[0]!.sources[0]!, fixture("lxgw-regular.css")],
      [lxgw.sheets[1]!.sources[0]!, fixture("lxgw-bold.css")],
    ]);

    await expect(downloadCatalogFont(lxgw)).resolves.toBe(105_359 + 105_068);
    expect(document.getElementById("catalog-font-lxgw")!.textContent).not.toContain("nowhere");
  });

  it("is not written when the sheets never verified", async () => {
    // All-or-nothing has to reach the store too: a rejected install that left a
    // copy behind would make the next launch adopt exactly what this one
    // refused.
    stubFetch([
      [
        lxgw.sheets[0]!.sources[0]!,
        new TextEncoder().encode("not the pinned sheet").buffer as ArrayBuffer,
      ],
      [lxgw.sheets[1]!.sources[0]!, fixture("lxgw-bold.css")],
    ]);

    await expect(downloadCatalogFont(lxgw)).rejects.toThrow(/校验失败/);
    expect(localStorage.getItem(SHEET_STORE)).toBeNull();
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

  it("drops the kept sheet with it, so 删除 means 删除", async () => {
    // Otherwise 删除 takes the font off the screen and leaves its sheet in
    // storage: the reader uninstalls to reclaim something, and gets nothing
    // back until the next reset.
    stubFetch([
      [noto.sheets[0]!.sources[0]!, fixture("noto-serif-sc-400.css")],
      [noto.sheets[1]!.sources[0]!, fixture("noto-serif-sc-700.css")],
    ]);
    await downloadCatalogFont(noto);
    expect(localStorage.getItem(SHEET_STORE)).toContain(noto.id);

    removeCatalogFont(noto.id);

    expect(localStorage.getItem(SHEET_STORE)).not.toContain(noto.id);
  });
});

describe("forgetCatalogFonts", () => {
  it("takes every catalogue face out of the document, and the store with it", () => {
    adoptCatalogFont(noto.id, "@font-face {}");
    adoptCatalogFont(lxgw.id, "@font-face {}");
    localStorage.setItem(
      SHEET_STORE,
      JSON.stringify({ [noto.id]: { fingerprint: "x", css: "y" } }),
    );

    forgetCatalogFonts();

    expect(isCatalogAdopted(noto.id)).toBe(false);
    expect(isCatalogAdopted(lxgw.id)).toBe(false);
    expect(localStorage.getItem(SHEET_STORE)).toBeNull();
  });

  it("leaves every other stylesheet in the document alone", () => {
    // The selector is what stands between 重置 and the reader's *imported*
    // fonts, which this reset deliberately does not touch — those are files
    // they put on their own machine. Widening it to `style` would wipe them,
    // and nothing else in the suite would notice.
    const imported = document.createElement("style");
    imported.id = "imported-fonts";
    imported.textContent = '@font-face { font-family: "cr-1" }';
    document.head.append(imported);
    adoptCatalogFont(noto.id, "@font-face {}");

    forgetCatalogFonts();

    expect(document.getElementById("imported-fonts")).not.toBeNull();
    imported.remove();
  });
});
