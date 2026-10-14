import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

import {
  CATALOG_FONTS,
  catalogFontById,
  catalogFontOfKey,
  catalogIdOfKey,
  catalogKey,
  catalogSheetBytes,
  rewriteSheetUrls,
  sha256Hex,
  sheetMatches,
} from "./fontCatalog";

// jsdom ships no SubtleCrypto; the manifest's hash check is the whole point of
// this module, so it runs against node's real implementation rather than a
// stub that would make every assertion vacuous.
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the catalogue data", () => {
  it("carries only fonts whose licence permits serving the bytes ourselves", () => {
    // The brand faces (HarmonyOS Sans, MiSans, OPPO Sans, 阿里巴巴普惠体) are
    // absent on purpose: their agreements forbid redistributing the font
    // files, which is what a CDN copy is. OFL is the licence that permits it.
    for (const font of CATALOG_FONTS) {
      expect(font.license, font.id).toBe("SIL OFL 1.1");
      expect(font.licenseUrl, font.id).toMatch(/^https:\/\//);
      expect(font.family, font.id).not.toBe("");
      expect(font.stack, font.id).toContain(font.family);
      expect(font.fallbackKey, font.id).not.toBe("");
    }
  });

  it("pins every sheet: fallback sources, a hash, a size", () => {
    for (const font of CATALOG_FONTS) {
      expect(font.sheets.length, font.id).toBeGreaterThan(0);
      // One entry per weight: two rules for one weight would be two ways to
      // render the same glyphs.
      const weights = font.sheets.map((sheet) => sheet.weight);
      expect(new Set(weights).size, font.id).toBe(weights.length);
      for (const sheet of font.sheets) {
        expect(sheet.sources.length, `${font.id}/${sheet.weight}`).toBeGreaterThanOrEqual(2);
        for (const source of sheet.sources) {
          expect(source, font.id).toMatch(/^https:\/\//);
        }
        expect(sheet.sha256, font.id).toMatch(/^[0-9a-f]{64}$/);
        expect(sheet.bytes, font.id).toBeGreaterThan(0);
      }
      expect(catalogSheetBytes(font), font.id).toBe(
        font.sheets.reduce((total, sheet) => total + sheet.bytes, 0),
      );
    }
    // A duplicated id would collide in the settings list and in the adopted
    // <style> element's id.
    const ids = CATALOG_FONTS.map((font) => font.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("keys", () => {
  it("round-trips through the prefix", () => {
    expect(catalogKey("lxgw")).toBe("catalog:lxgw");
    expect(catalogIdOfKey("catalog:lxgw")).toBe("lxgw");
    expect(catalogFontOfKey("catalog:lxgw")?.id).toBe("lxgw");
  });

  it("answers null for every key that is not a catalogue font", () => {
    for (const key of ["lxgw", "catalog:", "custom:7f1c", "system", ""]) {
      expect(catalogIdOfKey(key), key).toBeNull();
      expect(catalogFontOfKey(key), key).toBeNull();
    }
  });

  it("answers null for an id the catalogue does not carry", () => {
    expect(catalogFontById("retired")).toBeNull();
    expect(catalogFontOfKey("catalog:retired")).toBeNull();
  });
});

describe("rewriteSheetUrls", () => {
  it("resolves the sheet's relative subsets against the sheet's own URL", () => {
    // This is the resolution the browser would do fetching the sheet over
    // HTTP; an adopted <style> has no sheet URL to resolve against.
    const css =
      "@font-face { src: url('./files/lxgwwenkai-regular-subset-4.woff2') format('woff2'); }";
    expect(
      rewriteSheetUrls(
        css,
        "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css",
      ),
    ).toContain(
      'url("https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/files/lxgwwenkai-regular-subset-4.woff2")',
    );
  });

  it("leaves absolute, data and bare URLs alone", () => {
    const css =
      "url(https://cdn.example/x.woff2) url('data:font/woff2;base64,AAA') url(/same/origin.woff2)";
    expect(rewriteSheetUrls(css, "https://unpkg.com/pkg@1.0.0/x.css")).toBe(css);
  });
});

describe("the hash check", () => {
  it("hashes bytes the way the manifest pinned them", async () => {
    // A known vector, so a wrong digest length or a non-hex encoding fails
    // here rather than as a manifest entry that never verifies.
    const bytes = new TextEncoder().encode("abc").buffer as ArrayBuffer;
    expect(await sha256Hex(bytes)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("accepts the exact bytes and refuses anything else", async () => {
    const bytes = new TextEncoder().encode("a stylesheet").buffer as ArrayBuffer;
    const hash = await sha256Hex(bytes);
    await expect(sheetMatches(bytes, hash)).resolves.toBe(true);
    await expect(sheetMatches(bytes, hash.toUpperCase())).resolves.toBe(true);
    const other = new TextEncoder().encode("a different stylesheet").buffer as ArrayBuffer;
    await expect(sheetMatches(other, hash)).resolves.toBe(false);
  });
});
