import { describe, expect, it } from "vitest";

import { locateLayerText } from "./pdfTextSelection";

/**
 * `locateLayerText` anchors the read-aloud wash in a page's text layer. The
 * layer is real DOM here: one span per pdf.js text item, exactly as the
 * viewer builds them.
 */

const layer = (...spans: string[]): HTMLElement => {
  const div = document.createElement("div");
  for (const text of spans) {
    const span = document.createElement("span");
    span.textContent = text;
    div.append(span);
  }
  return div;
};

describe("locateLayerText", () => {
  it("finds the needle exactly when the whitespace agrees", () => {
    // Layer: "Hello world of PDF" — needle starts at 6.
    const hit = locateLayerText(layer("Hello ", "world of PDF"), "world of", 0, 5);
    expect(hit).toEqual({ start: 6, end: 11 });
  });

  it("resolves a span inside the needle, not just its head", () => {
    // Layer: "Hello world of PDF" — "of" sits at 12.
    const hit = locateLayerText(layer("Hello ", "world of PDF"), "world of PDF", 6, 8);
    expect(hit).toEqual({ start: 12, end: 14 });
  });

  it("collapses whitespace when the two pipelines disagree", () => {
    // Layer: "Hello  world" (two spaces, pdf.js item spacing); the spoken
    // sentence has one. Exact match fails, the collapsed one must not.
    const hit = locateLayerText(layer("Hel", "lo  wo", "rld"), "Hello world", 6, 11);
    expect(hit).toEqual({ start: 7, end: 12 });
  });

  it("carries the span across the collapse", () => {
    // Layer: "A  big  cat"; needle "A big cat", span "big" at 2..5.
    const hit = locateLayerText(layer("A  big  cat"), "A big cat", 2, 5);
    expect(hit).toEqual({ start: 3, end: 6 });
  });

  it("returns null when the text is not on the page", () => {
    expect(locateLayerText(layer("Hello world"), "Goodbye", 0, 3)).toBeNull();
  });

  it("returns null for an empty or degenerate span", () => {
    expect(locateLayerText(layer("Hello"), "", 0, 0)).toBeNull();
    expect(locateLayerText(layer("Hello"), "Hello", 2, 2)).toBeNull();
  });
});
