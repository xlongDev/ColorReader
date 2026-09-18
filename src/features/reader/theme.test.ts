import { afterEach, describe, expect, it } from "vitest";

import {
  bundledFacesFor,
  bundledFontFaces,
  customFontFamily,
  customFontKey,
  fontFaceCss,
  resolveFont,
} from "./theme";

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

/**
 * The bundled-face read-back, against stylesheets shaped like the webfont
 * package's: one `@font-face` per `unicode-range` subset, at several weights,
 * authored `font-display: swap` like the real ones.
 *
 * **What these tests cannot see.** jsdom's CSSOM parses only a subset of the
 * `@font-face` descriptors — `src`, `unicode-range` and `font-display` are all
 * dropped on the way in, so `rule.cssText` comes back as little more than the
 * family and the weight. That leaves the url rewrite (the one part that
 * differs between dev and a built app) untestable here, and it is tested the
 * only way it can be: by loading a book with 霞鹜文楷 selected in a real
 * engine and measuring the three faces against each other. Both Chromium and
 * WebKit were checked that way when this landed.
 *
 * **The dropped `font-display` has a second consequence.** Because the
 * descriptor never survives into `cssText` here, `withBlockDisplay` takes its
 * insertion branch in every one of these tests. In a real engine it survives —
 * 291 of 291 霞鹜文楷 rules read back as `block`, in both engines — and the
 * replacement branch is the one that runs. The two branches agree on their
 * output, which is what the assertions below pin down; which one produced it
 * is an environment detail. That the descriptor is not merely *present* but
 * *honoured* was measured separately: with the font held back at the network
 * layer, the shipped rules drew no ink at all where the same rules as `swap`
 * drew the fallback face, in Chromium and in WebKit alike.
 *
 * So what is pinned down below is the *selection* — which rules are carried,
 * and for whom — which is the half jsdom can answer for.
 */
const installed: HTMLStyleElement[] = [];

function install(css: string): void {
  const element = document.createElement("style");
  element.textContent = css;
  document.head.append(element);
  installed.push(element);
}

function face(family: string, weight: string, url: string, display = "swap"): string {
  return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-display: ${display}; src: url("${url}") format("woff2"); }`;
}

afterEach(() => {
  for (const element of installed.splice(0)) element.remove();
});

describe("bundledFontFaces", () => {
  it("reads back only the family asked for", () => {
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));
    install(face("Some Other Face", "400", "/assets/other.woff2"));

    const css = bundledFontFaces("LXGW WenKai");
    expect(css).toContain('font-family: "LXGW WenKai"');
    expect(css).not.toContain("Some Other Face");
  });

  it("carries only the weights a book's body text uses", () => {
    install(face("LXGW WenKai", "300", "light.woff2"));
    install(face("LXGW WenKai", "400", "regular.woff2"));
    install(face("LXGW WenKai", "700", "bold.woff2"));

    const css = bundledFontFaces("LXGW WenKai");
    // 300 and the package's monospace cut would add ~320 KB of rules to every
    // section document for a weight no book body text asks for.
    expect(css).not.toContain("font-weight: 300");
    expect(css).toContain("font-weight: 400");
    expect(css).toContain("font-weight: 700");
  });

  it("takes the weights it is asked for instead", () => {
    install(face("LXGW WenKai", "300", "light.woff2"));
    install(face("LXGW WenKai", "400", "regular.woff2"));

    const css = bundledFontFaces("LXGW WenKai", ["300"]);
    expect(css).toContain("font-weight: 300");
    expect(css).not.toContain("font-weight: 400");
  });

  it("holds the face back instead of swapping it in late", () => {
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));

    const css = bundledFontFaces("LXGW WenKai");
    // A late 霞鹜文楷 is the whole of "页面字体先会变成楷体再变成霞鹜文楷": the
    // section paints in 楷体, the next family in the stack, and changes under
    // the reader once the subsets land. `block` spends that moment showing
    // nothing rather than the wrong face.
    expect(css).toContain("font-display: block");
    expect(css).not.toContain("font-display: swap");
  });

  it("leaves exactly one display mode on a rule", () => {
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));

    // A second declaration would be harmless in effect, but it would mean the
    // rewrite ran twice over the same rule.
    expect(bundledFontFaces("LXGW WenKai").match(/font-display/g) ?? []).toHaveLength(1);
  });

  it("is empty for a family nothing declares", () => {
    expect(bundledFontFaces("Nobody Ships This")).toBe("");
  });

  it("is empty when no stylesheet declares anything at all", () => {
    expect(bundledFontFaces("LXGW WenKai")).toBe("");
  });
});

describe("bundledFacesFor", () => {
  it("carries 霞鹜文楷, which the app ships", () => {
    // The bug: the reader picks 霞鹜文楷, the section document has no such
    // face, and the stack falls through to "Kaiti SC" — the system kaiti.
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));
    expect(bundledFacesFor("lxgw")).toContain('font-family: "LXGW WenKai"');
  });

  it("carries nothing for the faces the platform provides", () => {
    // These resolve inside the section document on their own; injecting
    // anything would be a no-op at best. An imported font comes through
    // `fontFaceCss` instead, and a key nothing knows falls back to `system`.
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));
    expect(bundledFacesFor("song")).toBe("");
    expect(bundledFacesFor("kai")).toBe("");
    expect(bundledFacesFor("hei")).toBe("");
    expect(bundledFacesFor("system")).toBe("");
    expect(bundledFacesFor("custom:7f1c")).toBe("");
    expect(bundledFacesFor("made-up")).toBe("");
  });
});
