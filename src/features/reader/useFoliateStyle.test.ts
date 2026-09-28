import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bundledFacesFor, type ReadingSurface } from "@/features/reader/theme";
import { useFoliateStyle, type FoliateStyleOptions } from "@/features/reader/useFoliateStyle";
import type { LocalFont } from "@/types/ipc";

/** Only the three fields the sheet reads; the rest of the surface is the
 *  shell's business. */
const surface = (over: Partial<ReadingSurface> = {}): ReadingSurface =>
  ({ fg: "#c9ced8", tint: "#181c23", mode: "dark", ...over }) as ReadingSurface;

function setup(overrides: Partial<FoliateStyleOptions> = {}) {
  const options: FoliateStyleOptions = {
    fontSize: 18,
    font: "songti",
    lineHeightIdx: 1,
    paraGapIdx: 1,
    indent: true,
    surface: surface(),
    invertImages: false,
    fonts: [],
    vertical: false,
    ...overrides,
  };
  return renderHook((props: FoliateStyleOptions) => useFoliateStyle(props), {
    initialProps: options,
  });
}

describe("useFoliateStyle", () => {
  /** Surfaces are absolute: the reader can sit on a night page while the app
   *  is in day mode, so the sheet follows the surface, not the shell. */
  it("takes its palette from the reading surface, not the shell theme", () => {
    const night = setup({ surface: surface({ mode: "dark", fg: "#c9ced8", tint: "#181c23" }) });
    expect(night.result.current.dark).toBe(true);
    expect(night.result.current.fg).toBe("#c9ced8");
    expect(night.result.current.bg).toBe("#181c23");

    const day = setup({ surface: surface({ mode: "light", fg: "#222", tint: "#fff" }) });
    expect(day.result.current.dark).toBe(false);
    expect(day.result.current.fg).toBe("#222");
  });

  /** Inverting the book's own pictures is the reader's call, and it is not
   *  the same question as "is this page dark". */
  it("keeps inverting pictures a decision of its own", () => {
    const off = setup({ surface: surface({ mode: "dark" }), invertImages: false });
    expect(off.result.current.invertImages).toBe(false);

    const on = setup({ surface: surface({ mode: "light" }), invertImages: true });
    expect(on.result.current.invertImages).toBe(true);
  });

  it("falls back to the default leading and gap for an index off the scale", () => {
    const { result } = setup({ lineHeightIdx: 99, paraGapIdx: -1 });
    expect(result.current.lineHeight).toBe(1.7);
    expect(result.current.paraGap).toBe(0.9);
  });

  it("carries the type and the CJK flag through", () => {
    const { result } = setup({ fontSize: 22, indent: false, vertical: true });
    expect(result.current.fontSize).toBe(22);
    expect(result.current.indent).toBe(false);
    expect(result.current.vertical).toBe(true);
  });

  /**
   * The sheet has to carry the faces itself — a section is a document of its
   * own, so the app's declarations do not reach inside it. Two sources are
   * joined, and a source with nothing to say must leave **no separator**
   * behind: the string is concatenated straight into the top of the
   * stylesheet, so a stray newline becomes a stray blank line there.
   */
  it("joins the font faces without leaving a separator behind", () => {
    const font = { id: "f1", family: "My Face", path: "/tmp/f.woff2" } as unknown as LocalFont;

    const none = setup({ fonts: [] }).result.current.fontFaces;
    const some = setup({ fonts: [font] }).result.current.fontFaces;

    // Nothing imported: exactly the bundled faces, nothing before them.
    expect(none).toBe(bundledFacesFor("songti"));
    for (const faces of [none, some]) {
      expect(faces.startsWith("\n")).toBe(false);
      expect(faces.endsWith("\n")).toBe(false);
    }
    // An imported face changes the sheet; it is not silently dropped.
    expect(some).not.toBe(none);
  });
});
