import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useScanPages } from "@/stores/scanPages";
import { loadDoc } from "@/lib/pdf";

import { PdfPageView } from "./PdfPageView";

/**
 * What this page tells the rest of the reader about its own text layer.
 *
 * `PdfPageView` is the only thing that builds a text layer, so it is the only
 * thing that can say whether a page came out empty — and the footer's scan chip
 * needs exactly that, from outside the page. These cases hold a text layer
 * build open by hand, which is the only way to stand inside the window between
 * "canvas ready" and "layer built" and look at what is published.
 *
 * Everything below the component is faked — pdf.js, the document, the canvas —
 * because the question here is not what a page looks like but what the reader
 * is told about it, and the answer is decided in this component's own state.
 */

/** Text layer builds the test is holding open, and how many were started. */
const layers = vi.hoisted(() => ({
  pending: [] as Array<{ text: string; done: Promise<void> }>,
  started: 0,
}));

vi.mock("pdfjs-dist", () => ({
  TextLayer: class {
    private readonly container: HTMLElement;
    constructor({ container }: { container: HTMLElement }) {
      this.container = container;
    }
    /** Called when the reader turns away from a layer that is still building. */
    cancel() {}
    async render() {
      layers.started += 1;
      const build = layers.pending.shift();
      if (!build) throw new Error("a text layer was built that the test did not queue");
      await build.done;
      if (build.text === "") return;
      const span = document.createElement("span");
      span.textContent = build.text;
      this.container.append(span);
    }
  },
}));

vi.mock("@/lib/pdf", () => ({ loadDoc: vi.fn() }));

/** A gate the test opens by hand. */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done, open };
}

/** A page that rasterises at once; only its text layer is the test's to hold. */
function fakeDoc() {
  return {
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale,
        scale,
        rotation: 0,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      streamTextContent: () => ({}),
    }),
  };
}

beforeEach(() => {
  layers.pending.length = 0;
  layers.started = 0;
  useScanPages.setState({ empty: new Set(), recognised: new Set() });
  vi.mocked(loadDoc).mockResolvedValue(fakeDoc() as never);
  // jsdom measures every box at zero and has no 2d context, so a page would
  // never reach the state this suite is about: ready, with the layer pending.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(1000);
});

const view = (pageNumber: number) => <PdfPageView bookId="b1" pageNumber={pageNumber} fit="box" />;

/** Whether the page's build has been reported to the chrome as having no text. */
const reported = (page: number) => useScanPages.getState().empty.has(`b1|${page}`);

describe("what the page reports about its text layer", () => {
  it("says nothing while the text layer is still being built", async () => {
    const held = gate();
    layers.pending.push({ text: "正文", done: held.done });

    const page = render(view(1));
    // The canvas is up: the text layer is the only thing still missing, which
    // is the window the scan notice used to appear in.
    await waitFor(() => expect(page.container.querySelector("[data-pdf-raster]")).not.toBeNull());
    expect(layers.started).toBe(1);
    expect(reported(1)).toBe(false);

    await act(async () => held.open());
    expect(reported(1)).toBe(false);
  });

  it("reports a page whose text layer came out empty", async () => {
    layers.pending.push({ text: "", done: Promise.resolve() });
    render(view(1));

    await waitFor(() => expect(reported(1)).toBe(true));
  });

  it("reports a page with text as not a scan", async () => {
    layers.pending.push({ text: "正文", done: Promise.resolve() });
    render(view(1));

    await waitFor(() => expect(layers.started).toBe(1));
    expect(reported(1)).toBe(false);
  });

  it("follows the page the reader turns to", async () => {
    layers.pending.push({ text: "", done: Promise.resolve() });
    const page = render(view(1));
    await waitFor(() => expect(reported(1)).toBe(true));

    const held = gate();
    layers.pending.push({ text: "", done: held.done });
    page.rerender(view(2));
    await waitFor(() => expect(layers.started).toBe(2));

    // Page 1 keeps its verdict — it is still true of page 1 — and page 2 has
    // none until its own layer lands. That keying is what stopped a turn from
    // reading the page the reader just left as the page they are on.
    expect(reported(1)).toBe(true);
    expect(reported(2)).toBe(false);

    await act(async () => held.open());
    expect(reported(2)).toBe(true);
  });
});
