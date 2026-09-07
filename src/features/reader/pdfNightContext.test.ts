import { describe, expect, it } from "vitest";

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
