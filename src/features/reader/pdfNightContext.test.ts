import { describe, expect, it, vi } from "vitest";

import { remapColor, wrapNightContext, type NightAxis } from "./pdfNightContext";

/** The 夜间 surface: ink and paper ends of the axis. */
const AXIS: NightAxis = { fg: "#c9ced8", bg: "#181c23" };

/** A context stub: the wrapper only needs the members pdf.js touches. */
function stub(extra: Record<string, unknown> = {}) {
  return { fillStyle: "", strokeStyle: "", ...extra } as unknown as CanvasRenderingContext2D;
}

describe("remapColor", () => {
  it("sends black ink to the light end and white paper to the dark end", () => {
    expect(remapColor("#000000", AXIS)).toBe("#c9ced8");
    expect(remapColor("#ffffff", AXIS)).toBe("#181c23");
  });

  it("leaves transparent and unparseable colours alone", () => {
    expect(remapColor("transparent", AXIS)).toBe("transparent");
    expect(remapColor("rgba(0, 0, 0, 0)", AXIS)).toBe("rgba(0, 0, 0, 0)");
    expect(remapColor("repeating-linear-gradient(#fff, #000)", AXIS)).toBe(
      "repeating-linear-gradient(#fff, #000)",
    );
  });

  it("keeps a red heading red instead of flipping it to cyan", () => {
    const out = remapColor("#e01b24", AXIS);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(out.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g!);
    expect(r).toBeGreaterThan(b!);
  });
});

describe("wrapNightContext", () => {
  it("rewrites assigned colours", () => {
    const raw = stub();
    const ctx = wrapNightContext(raw, { ...AXIS });
    ctx.fillStyle = "#000000";
    ctx.strokeStyle = "#ffffff";
    expect(raw.fillStyle).toBe("#c9ced8");
    expect(raw.strokeStyle).toBe("#181c23");
  });

  it("passes the canvas ground colour through untouched", () => {
    const raw = stub();
    const ctx = wrapNightContext(raw, { ...AXIS, background: "#181c23" });
    ctx.fillStyle = "#181c23";
    expect(raw.fillStyle).toBe("#181c23");
  });

  it("recolours gradient stops", () => {
    const stops: string[] = [];
    const raw = stub({
      createLinearGradient: () => ({
        addColorStop: (_offset: number, color: string) => stops.push(color),
      }),
    });
    wrapNightContext(raw, { ...AXIS })
      .createLinearGradient(0, 0, 1, 1)
      .addColorStop(0, "#000000");
    expect(stops).toEqual(["#c9ced8"]);
  });
});

/** A 2D context that writes every composite step down instead of rasterising
 *  it. jsdom has no canvas, so the inversion pipeline — which is a sequence of
 *  blend modes, not arithmetic — can only be pinned by the order it issues
 *  them in. What those blends *produce* is a browser question, measured once
 *  against real engines and recorded in the module note. */
function recorder(tag: string, into: string[]) {
  const ctx = {
    globalCompositeOperation: "source-over",
    fillStyle: "",
    clearRect: () => into.push(`${tag}:clear`),
    fillRect: () => into.push(`${tag}:fill:${ctx.globalCompositeOperation}:${ctx.fillStyle}`),
    // The numbers matter as much as the blend order: `drawImage` has three
    // shapes, and reading the wrong one misplaces the picture.
    drawImage: (_image: unknown, ...args: number[]) =>
      into.push(`${tag}:draw:${ctx.globalCompositeOperation}:${args.join(",")}`),
  };
  return ctx;
}

describe("wrapNightContext image inversion", () => {
  /** fg #c9ced8 over bg #181c23: the distance and the floor the ramp needs. */
  const SPREAD = "rgb(177, 178, 181)";
  const FLOOR = "rgb(24, 28, 35)";

  it("drops the chroma before flipping the luminance", () => {
    const scratchOps: string[] = [];
    const outerOps: string[] = [];
    const scratch = recorder("scratch", scratchOps);
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 0,
      height: 0,
      getContext: () => scratch,
    } as unknown as HTMLCanvasElement);

    const ctx = wrapNightContext(recorder("outer", outerOps) as never, {
      ...AXIS,
      invertImages: true,
    });
    ctx.drawImage({ width: 4, height: 4 } as CanvasImageSource, 0, 0, 4, 4);

    // `saturation` before `difference` is the whole point: a negative of a
    // colour pixel is its complement, so skin turns cyan unless the chroma is
    // gone first. The ramp lands white paper on `bg` and black ink on `fg`.
    expect(scratchOps).toEqual([
      "scratch:clear",
      "scratch:draw:source-over:0,0,4,4",
      `scratch:fill:saturation:#808080`,
      "scratch:fill:difference:#ffffff",
      `scratch:fill:multiply:${SPREAD}`,
      `scratch:fill:lighter:${FLOOR}`,
    ]);
    expect(outerOps).toEqual(["outer:draw:source-over:0,0,4,4"]);
  });

  /** pdf.js only ever draws images through `drawImageAtIntegerCoords`, which
   *  emits the eight-number form — source rect first, then destination. That
   *  is one number longer than the plain `dw,dh` form, and taking the wrong
   *  branch sizes the scratch from the *source* rect: on a bitmap with few
   *  pixels stretched wide, the picture collapses to a dot. */
  it("reads the eight-number form pdf.js actually emits", () => {
    const scratchOps: string[] = [];
    const outerOps: string[] = [];
    // Kept by reference: the wrapper sizes the element it was handed, so the
    // mock has to be the very object it gets back.
    const scratchEl = { width: 0, height: 0, getContext: () => recorder("scratch", scratchOps) };
    vi.spyOn(document, "createElement").mockReturnValue(scratchEl as unknown as HTMLCanvasElement);

    const ctx = wrapNightContext(recorder("outer", outerOps) as never, {
      ...AXIS,
      invertImages: true,
    });
    // (sx,sy,sw,sh = 0,0,2,2) then (dx,dy,dw,dh = 0,-1,40,80): a 2x2 bitmap
    // painted into a 40x80 box, the shape pdf.js hands a stretched one.
    ctx.drawImage({ width: 2, height: 2 } as CanvasImageSource, 0, 0, 2, 2, 0, -1, 40, 80);

    // Sized from the destination box, cropped from the source rect, and
    // blitted where pdf.js asked — not at the source rect's origin.
    expect([scratchEl.width, scratchEl.height]).toEqual([40, 80]);
    expect(scratchOps[1]).toBe("scratch:draw:source-over:0,0,2,2,0,0,40,80");
    expect(outerOps).toEqual(["outer:draw:source-over:0,-1,40,80"]);
  });

  it("leaves images alone when the reader did not ask for it", () => {
    const outerOps: string[] = [];
    const ctx = wrapNightContext(recorder("outer", outerOps) as never, { ...AXIS });
    ctx.drawImage({ width: 4, height: 4 } as CanvasImageSource, 0, 0, 4, 4);
    expect(outerOps).toEqual(["outer:draw:source-over:0,0,4,4"]);
  });
});
