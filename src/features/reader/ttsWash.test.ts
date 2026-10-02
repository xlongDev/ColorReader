import { describe, expect, it } from "vitest";

import { TTS_WASH_STYLES, foliateWash, parseWashHex, washCss, washInk, washRule } from "./ttsWash";

const MARKER = "#ffd12e";

/** `rgba(r, g, b, a)` — the alpha is the fourth component. */
const alphaOf = (rgba: string) => Number(rgba.slice(0, -1).split(", ")[3]);

describe("the read-aloud wash", () => {
  it("falls back to the app's own ink per surface, and lends it to a line", () => {
    expect(washInk(null, true)).toBe("#e9a13b");
    expect(washInk(null, false)).toBe("#96591a");
    expect(washInk(MARKER, true)).toBe(MARKER);
    expect(washCss("underline", null, true).textDecorationColor).toBe(washInk(null, true));
  });

  it("leaves the theme colour on the token instead of copying its two values", () => {
    expect(washCss("highlight", null, true).backgroundColor).toBe("var(--accent-soft)");
    expect(washCss("highlight", null, false).backgroundColor).toBe("var(--accent-soft)");
  });

  it("lays a marker on at the annotation highlights' own strength", () => {
    expect(washCss("highlight", MARKER, true).backgroundColor).toBe("rgba(255, 209, 46, 0.26)");
    expect(washCss("highlight", MARKER, false).backgroundColor).toBe("rgba(255, 209, 46, 0.36)");
  });

  it("draws every line style in the ink it was handed", () => {
    for (const { key } of TTS_WASH_STYLES) {
      if (key === "highlight") continue;
      for (const dark of [true, false]) {
        const css = JSON.stringify(washCss(key, MARKER, dark));
        expect(css).toContain(MARKER);
        // A line is opaque: a translucent rule reads as a rendering defect.
        expect(css).not.toMatch(/rgba\(/);
        expect(css).not.toContain("backgroundColor");
      }
    }
  });

  it("gives every style a shape of its own", () => {
    const shapes = TTS_WASH_STYLES.map(({ key }) => JSON.stringify(washCss(key, MARKER, true)));
    expect(new Set(shapes).size).toBe(TTS_WASH_STYLES.length);
  });

  it("outlines the glyphs rather than boxing the run, so a wrapped run cannot be framed", () => {
    const css = washCss("outline", MARKER, true);
    expect(css.outline).toBeUndefined();
    expect(css.backgroundColor).toBeUndefined();
    // Four offsets: one per side, or the ink covers the letter instead.
    expect(String(css.textShadow).split(", ")).toHaveLength(4);
  });

  it("serialises to real CSS, with every length carrying its unit", () => {
    const rule = washRule("highlight", MARKER, true);
    expect(rule).toBe("background-color: rgba(255, 209, 46, 0.26); border-radius: 2px;");
    expect(washRule("squiggly", MARKER, true)).toContain("text-decoration: underline wavy;");
    expect(washRule("underline", MARKER, true)).toContain("text-underline-offset: 3px;");
    // A bare number is not a length: the browser drops the declaration, and the
    // PDF wash then draws at the default weight instead of the chosen one.
    for (const { key } of TTS_WASH_STYLES) {
      const serialised = washRule(key, MARKER, true);
      expect(serialised, key).not.toMatch(/:\s*[\d.]+\s*;/);
    }
  });

  it("divides the colour back up for foliate's own opacity", () => {
    // foliate paints the group at 0.3, so the colour has to carry the rest.
    expect(alphaOf(foliateWash("highlight", MARKER, true).color) * 0.3).toBeCloseTo(0.26, 6);
    // The theme wash keeps its hand-tuned constant rather than a division.
    expect(foliateWash("highlight", null, true).color).toBe("rgba(233, 161, 59, 0.533)");
    expect(foliateWash("highlight", null, false).color).toBe("rgba(150, 89, 26, 0.4)");
    // White paper asks for 0.36, more than a colour can carry — it tops out, and
    // that band is the one place the two paths disagree.
    expect(foliateWash("highlight", MARKER, false).color).toBe("rgba(255, 209, 46, 1)");
  });

  it("takes an ink off the reader's keyboard, however they spell it", () => {
    expect(parseWashHex("#56AEE2")).toBe("#56aee2");
    // The `#` is optional, because half of what a reader pastes does not have one.
    expect(parseWashHex("56aee2")).toBe("#56aee2");
    expect(parseWashHex("  #56aee2  ")).toBe("#56aee2");
    // Three digits expand the way CSS expands them.
    expect(parseWashHex("#f0a")).toBe("#ff00aa");
    // Anything that is not a colour is not a colour — the field reverts on
    // blur rather than storing a broken ink every renderer would then agree on.
    expect(parseWashHex("")).toBeNull();
    expect(parseWashHex("#56aee")).toBeNull();
    expect(parseWashHex("#gggggg")).toBeNull();
    expect(parseWashHex("blue")).toBeNull();
    expect(parseWashHex("rgb(1,2,3)")).toBeNull();
  });

  it("hands the line painters the plain ink, the same as an annotation does", () => {
    expect(foliateWash("underline", MARKER, true)).toEqual({ draw: "underline", color: MARKER });
    expect(foliateWash("squiggly", null, false)).toEqual({ draw: "squiggly", color: "#96591a" });
    expect(foliateWash("outline", null, true)).toEqual({ draw: "outline", color: "#e9a13b" });
  });
});
