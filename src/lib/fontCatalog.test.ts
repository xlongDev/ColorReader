import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

import {
  CATALOG_FILES,
  CATALOG_FONTS,
  archiveRequest,
  catalogFontById,
  catalogFontOfKey,
  catalogIdOfKey,
  catalogKey,
  catalogSheetBytes,
  handImported,
  rewriteSheetUrls,
  sha256Hex,
  sheetMatches,
} from "./fontCatalog";
import type { LocalFont } from "@/types/ipc";

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
    // OFL is the licence that permits a CDN copy, which is what a sheet entry
    // is. The brand faces are in `CATALOG_FILES` instead — their agreements
    // forbid the mirror but permit the vendor's own archive, and the tests for
    // that live in the describe below.
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
  });

  it("does not reuse an id, across both kinds", () => {
    // A duplicated id would collide in the settings list and in the adopted
    // <style> element's id — and a shared id between the kinds would have one
    // entry's row claim the other's install.
    const ids = [...CATALOG_FONTS, ...CATALOG_FILES].map((font) => font.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the archive catalogue", () => {
  it("carries a notice, a licence and a real URL for every entry", () => {
    for (const font of CATALOG_FILES) {
      expect(font.license, font.id).not.toBe("");
      expect(font.licenseUrl, font.id).toMatch(/^https:\/\//);
      // 🔴 The notice is a licence condition, not copy: HarmonyOS Sans's clause
      // 2.1 requires the software to state that its fonts are used, and the
      // settings row prints this string. A blank one would silently drop the
      // promise.
      expect(font.notice, font.id).not.toBe("");
      // And it has to name the font it is about, or it states nothing.
      expect(font.notice, font.id).toContain(font.name);
    }
  });

  it("pins the member it extracts, and says what the download costs", () => {
    for (const font of CATALOG_FILES) {
      expect(font.sources.length, font.id).toBeGreaterThan(0);
      for (const source of font.sources) expect(source, font.id).toMatch(/^https:\/\//);
      // The member, not the archive: the member is what lands on disk.
      expect(font.sha256, font.id).toMatch(/^[0-9a-f]{64}$/);
      // The extension is what `fonts::install` derives the stored file from,
      // and a member the webview cannot parse would install a face nothing
      // renders.
      expect(font.member, font.id).toMatch(/\.(?:ttf|otf|ttc|woff2?)$/);
      expect(font.licenseMember, font.id).toMatch(/\.txt$/);
      expect(font.bytes, font.id).toBeGreaterThan(0);
      // The archive is still the larger of the two — equal sizes would mean the
      // numbers were swapped.
      expect(font.archiveBytes, font.id).toBeGreaterThan(font.bytes);
      // 🔴 The point of the narrow route, stated as a number: what installing
      // costs must be *less* than the face itself, because the face travels
      // deflated. A figure at or above `bytes` would mean the entry had quietly
      // gone back to costing a whole-archive download, which is the thing this
      // field exists to report honestly.
      expect(font.downloadBytes, font.id).toBeLessThan(font.bytes);
      expect(font.downloadBytes, font.id).toBeLessThan(font.archiveBytes);
    }
  });

  it("is not reachable by a catalogue key", () => {
    // An archive face is selected as an imported font (`custom:<id>`), not as
    // `catalog:<id>`: there is no sheet to adopt, so a key that resolved here
    // would have `resolveFont` answer with a stack this entry does not have.
    for (const font of CATALOG_FILES) {
      expect(catalogFontOfKey(catalogKey(font.id)), font.id).toBeNull();
      expect(catalogFontById(font.id), font.id).toBeNull();
    }
  });

  it("sends the pin the backend holds the bytes up against", () => {
    for (const font of CATALOG_FILES) {
      const request = archiveRequest(font);
      // The hash is the entire check. A request that dropped it would install
      // whatever the network happened to answer with, which is the failure this
      // catalogue exists to make impossible.
      expect(request.sha256, font.id).toBe(font.sha256);
      expect(request.member, font.id).toBe(font.member);
      expect(request.catalogId, font.id).toBe(font.id);
      expect(request.name, font.id).toBe(font.name);
      expect(request.licenseMember, font.id).toBe(font.licenseMember);
      expect(request.sources, font.id).toEqual([...font.sources]);
    }
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

/** A stored font, as `reading.fonts` holds one. Module scope because the linter
 *  reads a helper defined inside `describe` as a closure rebuilt per call. */
const storedFont = (id: string, catalogId?: string): LocalFont => ({
  id,
  name: id,
  file: `${id}.ttf`,
  addedAt: 0,
  url: `colorreader://localhost/font/${id}`,
  catalogId,
});

describe("handImported", () => {
  it("holds back only the fonts a catalogue row is showing", () => {
    const kept = handImported([
      storedFont("by-hand"),
      storedFont("by-catalogue", "harmonyos-sans"),
      // An entry that has been retired from `CATALOG_FILES`: nothing renders a
      // row for it, so hiding the font would leave it on disk with no way to
      // delete it.
      storedFont("orphan", "retired-entry"),
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(["by-hand", "orphan"]);
  });

  it("keeps every font when no catalogue row matches", () => {
    // The browser backend never sets a catalogue id, so this is the whole list
    // on that side — and the answer has to be "all of it", not "none".
    const fonts = [storedFont("a"), storedFont("b")];
    expect(handImported(fonts)).toEqual(fonts);
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
