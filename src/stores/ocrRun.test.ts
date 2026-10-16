import { beforeEach, describe, expect, it, vi } from "vitest";

import { describeRun, useOcrRun, type OcrRun } from "./ocrRun";

// The two halves of one page — rendering it and sending it — are the webview's
// and the backend's. Mocked as controllable handles so the run can be driven
// without a PDF, a browser canvas or a model.
const render = vi.fn();
const ocrPage = vi.fn();
const showToast = vi.fn();

vi.mock("@/features/reader/pdfOcr", () => ({
  pageImageDataUrl: (...args: unknown[]) => render(...args),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { ocrPage: (...args: unknown[]) => ocrPage(...args) } }));
vi.mock("@/stores/toasts", () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

/** A promise the test decides when to settle, to look at a run mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** One page recognised, as `ocr.page` reports it. */
const stored = (page: number, chars = 12) => ({ page: page + 1, chars });

beforeEach(() => {
  render.mockReset().mockResolvedValue("data:image/jpeg;base64,AAAA");
  ocrPage.mockReset().mockImplementation(async (_bookId: string, page: number) => stored(page));
  showToast.mockReset();
  useOcrRun.setState({ run: null });
});

describe("useOcrRun.start", () => {
  it("recognises every page and reports the outcome", async () => {
    await useOcrRun.getState().start("b1", [0, 2, 3]);

    expect(useOcrRun.getState().run).toEqual({
      bookId: "b1",
      total: 3,
      index: 3,
      stored: [0, 2, 3],
      failed: [],
      status: "done",
    });
    expect(showToast).toHaveBeenCalledWith("success", expect.stringContaining("全书 3 页"));
  });

  it("renders the page itself, 1-based where the renderer is", async () => {
    await useOcrRun.getState().start("b7", [4]);

    // The two conventions meet in exactly one place: the store adds 1 for the
    // renderer, and the command takes the 0-based page the corpus indexes by.
    expect(render).toHaveBeenCalledWith("b7", 5);
    expect(ocrPage).toHaveBeenCalledWith("b7", 4, "data:image/jpeg;base64,AAAA");
  });

  it("names the page it is on while the run is still going", async () => {
    const first = deferred<{ page: number; chars: number }>();
    ocrPage.mockImplementationOnce(() => first.promise);

    const starting = useOcrRun.getState().start("b1", [0, 1, 2]);

    await vi.waitFor(() => {
      expect(useOcrRun.getState().run).toMatchObject({ index: 1, status: "running", stored: [] });
    });

    first.resolve(stored(0));
    await starting;

    expect(useOcrRun.getState().run).toMatchObject({
      index: 3,
      stored: [0, 1, 2],
      status: "done",
    });
  });

  it("keeps going past a page that failed, and names it", async () => {
    ocrPage.mockImplementation(async (_bookId: string, page: number) => {
      if (page === 1) throw new Error("这一页没成功");
      return stored(page);
    });

    await useOcrRun.getState().start("b1", [0, 1, 2]);

    expect(useOcrRun.getState().run).toMatchObject({ stored: [0, 2], failed: [1] });
    expect(showToast).toHaveBeenCalledWith("error", expect.stringContaining("1 页没成功"));
  });

  it("refuses a second run while one is live, and says why", async () => {
    const gate = deferred<{ page: number; chars: number }>();
    ocrPage.mockImplementationOnce(() => gate.promise);

    const starting = useOcrRun.getState().start("b1", [0]);
    await vi.waitFor(() => {
      expect(useOcrRun.getState().run?.status).toBe("running");
    });

    await useOcrRun.getState().start("b2", [0, 1, 2]);

    // b2's press changed nothing — one run at a time, and the refusal is
    // announced rather than dropped on the floor.
    expect(useOcrRun.getState().run?.bookId).toBe("b1");
    expect(ocrPage).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("error", expect.stringContaining("另一本书正在识别中"));

    gate.resolve(stored(0));
    await starting;
  });
});

describe("useOcrRun.stop", () => {
  it("says it is stopping, then keeps what it had", async () => {
    const gate = deferred<{ page: number; chars: number }>();
    ocrPage.mockImplementationOnce(() => gate.promise);

    const starting = useOcrRun.getState().start("b1", [0, 1, 2]);
    await vi.waitFor(() => {
      expect(useOcrRun.getState().run?.status).toBe("running");
    });

    useOcrRun.getState().stop();

    // The page in flight is not abandoned — its answer is already paid for, so
    // "stopping" is the honest state until it lands.
    expect(useOcrRun.getState().run?.status).toBe("stopping");

    gate.resolve(stored(0));
    await starting;

    expect(useOcrRun.getState().run).toMatchObject({
      // One page attempted of three: the counter reports how far the run got,
      // not how many pages it was handed.
      index: 1,
      total: 3,
      stored: [0],
      status: "done",
    });
    expect(ocrPage).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("success", expect.stringContaining("已识别 1 页"));
  });

  it("does nothing when there is no run to stop", () => {
    useOcrRun.getState().stop();
    expect(useOcrRun.getState().run).toBeNull();
  });
});

/** A finished ten-page run, with whatever the case is about patched in. */
const run = (patch: Partial<OcrRun>): OcrRun => ({
  bookId: "b1",
  total: 10,
  index: 10,
  stored: [],
  failed: [],
  status: "done",
  ...patch,
});

describe("describeRun", () => {
  it("calls a complete run complete", () => {
    const done = run({ stored: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    expect(describeRun(done, false)).toContain("全书 10 页都识别完了");
  });

  it("names the pages that failed without calling the run a failure", () => {
    const partial = run({ stored: [1, 2], failed: [3] });
    const said = describeRun(partial, false);
    expect(said).toContain("已识别 2 页");
    expect(said).toContain("1 页没成功");
  });

  it("does not blame the reader's own stop on the pages they skipped", () => {
    // Same two stored pages as above, but this time the other eight were never
    // tried. Reporting "8 页没成功" would be telling them something broke.
    const stopped = run({ stored: [1, 2], index: 2 });
    expect(describeRun(stopped, true)).toBe("已识别 2 页，剩下的可以随时继续。");
  });

  it("says nothing was gained when a stop landed before the first page", () => {
    expect(describeRun(run({ stored: [], index: 0 }), true)).toContain("还没有识别出文字");
  });
});
