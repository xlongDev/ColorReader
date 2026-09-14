import { describe, expect, it } from "vitest";

import { customFontFamily, customFontKey, fontFaceCss, resolveFont } from "./theme";

describe("resolveFont", () => {
  it("falls back to the system stack for a key it does not know", () => {
    expect(resolveFont("system")).toBe("var(--font-sans)");
    // A font deleted while it was still selected would leave such a key behind.
    expect(resolveFont("made-up")).toBe("var(--font-sans)");
  });

  it("names an imported font after its id, quoted", () => {
    // Unquoted, a uuid is not a valid family name and the whole declaration
    // would be invalid rather than merely wrong.
    expect(resolveFont(customFontKey("7f1c"))).toBe('"cr-7f1c"');
  });
});

describe("fontFaceCss", () => {
  const id = "abc-123";

  it("declares one face per imported font", () => {
    const css = fontFaceCss([{ id, url: "colorreader://localhost/font/abc-123" }]);
    expect(css).toContain(`font-family: "${customFontFamily(id)}"`);
    expect(css).toContain("colorreader://localhost/font/abc-123");
  });

  it("swaps the face in rather than blocking on it", () => {
    // The default is to hide text while the face downloads; a CJK font is tens
    // of megabytes, so that is a blank page for as long as it takes.
    expect(fontFaceCss([{ id, url: "u" }])).toContain("font-display: swap");
  });

  it("agrees with the family the picker's key resolves to", () => {
    // Two derivations of the same name. If they ever differ, selecting a font
    // would ask for a family that was never declared anywhere.
    expect(fontFaceCss([{ id, url: "u" }])).toContain(customFontFamily(id));
    expect(resolveFont(customFontKey(id))).toBe(`"${customFontFamily(id)}"`);
  });

  it("declares nothing when nothing is imported", () => {
    expect(fontFaceCss([])).toBe("");
  });
});
