import { beforeEach, describe, expect, it } from "vitest";

import { scanKey, useScanPages } from "./scanPages";

beforeEach(() => {
  useScanPages.setState({ empty: new Set(), recognised: new Set() });
});

describe("useScanPages", () => {
  it("says nothing about a page until a text layer has been built", () => {
    // The notice used to be drawn from "not built yet", which is exactly why it
    // flashed over every page of every ordinary PDF.
    expect(useScanPages.getState().empty.has(scanKey("b1", 5))).toBe(false);
  });

  it("records a page whose text layer came out empty", () => {
    useScanPages.getState().report("b1", 5, true);

    expect(useScanPages.getState().empty.has(scanKey("b1", 5))).toBe(true);
  });

  it("drops a page that turns out to have text", () => {
    useScanPages.getState().report("b1", 5, true);
    useScanPages.getState().report("b1", 5, false);

    expect(useScanPages.getState().empty.has(scanKey("b1", 5))).toBe(false);
  });

  it("keeps two books' page numbers apart", () => {
    useScanPages.getState().report("b1", 5, true);

    expect(useScanPages.getState().empty.has(scanKey("b2", 5))).toBe(false);
  });

  it("leaves the state alone when a verdict repeats", () => {
    useScanPages.getState().report("b1", 5, true);
    const before = useScanPages.getState();

    // A settled page re-reports on every rebuild — a resize, a theme flip, a
    // zoom — and waking every subscriber for it is what a re-render storm is.
    useScanPages.getState().report("b1", 5, true);

    expect(useScanPages.getState().empty).toBe(before.empty);
  });

  it("remembers a page a recognition has given text to", () => {
    useScanPages.getState().markRecognised("b1", 5);

    expect(useScanPages.getState().recognised.has(scanKey("b1", 5))).toBe(true);
  });
});
