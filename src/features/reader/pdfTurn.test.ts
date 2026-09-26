import { describe, expect, it } from "vitest";

import { pdfTurn } from "./pdfTurn";
import type { PageTransition } from "./theme";

/** The frame a turn ends on — where the outgoing sheet has gone. Empty when
    the setting has no animation, so an assertion naming a frame fails
    instead of passing against a turn that was never built. */
const end = (mode: PageTransition, dir: 1 | -1): Keyframe =>
  pdfTurn(mode, dir)?.frames.at(-1) ?? {};

describe("pdfTurn", () => {
  it("slides the sheet off the way the reader is going", () => {
    expect(end("slide", 1).transform).toBe("translateX(-100%)");
    expect(end("slide", -1).transform).toBe("translateX(100%)");
    // No column strip to scroll in a paged PDF, so `pan` is the same gesture.
    expect(end("pan", 1).transform).toBe("translateX(-100%)");
  });

  it("fades without moving the sheet", () => {
    expect(end("fade", 1).opacity).toBe(0);
    expect(end("fade", 1).transform).toBeUndefined();
  });

  it("folds about the spine on the side the sheet leaves from", () => {
    const forward = pdfTurn("paper", 1);
    expect(forward?.origin).toBe("left center");
    expect(end("paper", 1).transform).toContain("rotateY(-88deg)");

    const backward = pdfTurn("paper", -1);
    expect(backward?.origin).toBe("right center");
    expect(end("paper", -1).transform).toContain("rotateY(88deg)");
  });

  it("has nothing to play when the reader asked for none", () => {
    expect(pdfTurn("none", 1)).toBeNull();
  });
});
