import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useOcrRun, type OcrRun } from "@/stores/ocrRun";
import { useScanPages } from "@/stores/scanPages";

import { ScanChip } from "./ScanChip";

/**
 * The recognise chip, driven by the two stores it reads: which pages came out
 * of their text layer empty (`scanPages`), and whether a whole-book run is
 * going (`ocrRun`).
 *
 * `@/lib/ipc` and `./pdfOcr` are mocked because both ends of a recognition are
 * the desktop shell's — in jsdom there is no command to call and no canvas to
 * `toDataURL` — and `isDesktopRuntime` because outside the shell the chip is
 * not rendered at all.
 */

/** The page image a real render would produce; jsdom has no `toDataURL`. */
const { pageImage } = vi.hoisted(() => ({ pageImage: vi.fn() }));
/** What the backend answers; page is 0-based in, `page + 1` out. */
const { ocrPage } = vi.hoisted(() => ({ ocrPage: vi.fn() }));

vi.mock("./pdfOcr", () => ({ pageImageDataUrl: pageImage }));
vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: true,
  ipc: {
    ocrPage,
    ocrScannedPages: vi.fn(async () => ({ total: 1, pages: [0] })),
  },
}));

/** A finished run, with whatever the case is about patched in. */
const run = (patch: Partial<OcrRun>): OcrRun => ({
  bookId: "b1",
  total: 210,
  index: 3,
  stored: [],
  failed: [],
  status: "done",
  ...patch,
});

/** The page under the chip, 1-based as the reader counts it. */
const PAGE = 5;
/** The same page as the run store counts it. */
const ZERO = PAGE - 1;

/** A request left in flight until the test lets it land. */
function gate<T>(value: T) {
  let open!: () => void;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    run: async () => {
      await done;
      return value;
    },
    open,
  };
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // `restoreAllMocks` in the shared setup only covers `spyOn`, so these would
  // otherwise carry the previous case's calls and answers.
  pageImage.mockReset();
  pageImage.mockResolvedValue("data:image/jpeg;base64,");
  ocrPage.mockReset();
  ocrPage.mockResolvedValue({ page: PAGE, chars: 120 });
  useScanPages.setState({ empty: new Set(), recognised: new Set() });
  useOcrRun.setState({ run: null });
});

/** Page 5's text layer came out empty. */
const scanned = () => useScanPages.getState().report("b1", PAGE, true);

let client: QueryClient;

function show(page = PAGE) {
  return render(
    <QueryClientProvider client={client}>
      <ScanChip bookId="b1" page={page} />
    </QueryClientProvider>,
  );
}

describe("the chip on a page with no text layer", () => {
  it("names the page and offers both scales of the fix", () => {
    scanned();
    show();

    expect(screen.getByText("第 5 页没有文字层")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "识别这一页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "识别全书" })).toBeInTheDocument();
  });

  it("says nothing about a page that has text, or one not yet built", () => {
    // A page whose layer is still being built is not a scan — that mistake is
    // what flashed the notice over every page of every ordinary PDF.
    const { container } = show();
    expect(container).toBeEmptyDOMElement();

    useScanPages.getState().report("b1", PAGE, false);
    expect(container).toBeEmptyDOMElement();
  });

  it("asks for this page to be recognised, and then takes itself away", async () => {
    scanned();
    const { container } = show();

    await userEvent.click(screen.getByRole("button", { name: "识别这一页" }));

    expect(ocrPage).toHaveBeenCalledWith("b1", ZERO, "data:image/jpeg;base64,");
    // The page has text now, so the notice has nothing left to say.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("hides itself once the page has text, and stays hidden", async () => {
    scanned();
    show();

    await userEvent.click(screen.getByRole("button", { name: "识别这一页" }));
    await waitFor(() => expect(useScanPages.getState().recognised.has("b1|5")).toBe(true));

    // The record is the store's, not the component's: the reader navigates
    // away and back, and a page that has text must not be offered a second
    // recognition — the backend refuses it and that reads as a failure.
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
  });

  it("says it is working, and refuses a second press", async () => {
    const held = gate("data:image/jpeg;base64,");
    pageImage.mockImplementation(() => held.run());
    scanned();
    show();

    await userEvent.click(screen.getByRole("button", { name: "识别这一页" }));

    expect(screen.getByRole("button", { name: "正在识别…" })).toBeDisabled();
    await act(async () => held.open());
    await waitFor(() => expect(ocrPage).toHaveBeenCalledOnce());
  });

  it("opens the whole-book confirmation", async () => {
    scanned();
    show();

    await userEvent.click(screen.getByRole("button", { name: "识别全书" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("the chip while a run is going", () => {
  it("becomes the progress display, and drops the page's own buttons", () => {
    useOcrRun.setState({ run: run({ status: "running" }) });
    scanned();
    show();

    expect(screen.getByText("正在识别全书 第 3 / 210 页")).toBeInTheDocument();
    // The run covers this page too, so offering to recognise it separately
    // would be offering to do it twice.
    expect(screen.queryByRole("button", { name: "识别这一页" })).toBeNull();
    expect(screen.queryByRole("button", { name: "识别全书" })).toBeNull();
  });

  it("shows from a page that is not itself a scan", () => {
    // The bar used to be drawn on the page, so a run could only be watched
    // from a page that happened to be a scan — and the reader who went to read
    // something else had no way to stop it.
    useOcrRun.setState({ run: run({ status: "running" }) });
    show();

    expect(screen.getByText("正在识别全书 第 3 / 210 页")).toBeInTheDocument();
  });

  it("stops when asked", () => {
    useOcrRun.setState({ run: run({ status: "running" }) });
    show();

    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    expect(useOcrRun.getState().run?.status).toBe("stopping");
  });

  it("says it is stopping, and cannot be asked twice", () => {
    // The page in flight still has to land, which can take a round trip — so
    // the chip says so rather than looking like the click did nothing.
    useOcrRun.setState({ run: run({ status: "stopping" }) });
    show();

    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
  });

  it("ignores a run belonging to another book", () => {
    useOcrRun.setState({ run: run({ bookId: "b2", status: "running" }) });
    show();

    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(screen.queryByText("第 5 页没有文字层")).toBeNull();
  });
});

describe("the chip after a run", () => {
  it("takes itself away on a page the run recognised", () => {
    // Page 5 is 0-based 4. It has text now, so the chip's whole reason to exist
    // is gone — and leaving it would draw a refusal from the backend.
    useOcrRun.setState({ run: run({ stored: [4], index: 210 }) });
    const { container } = show();

    expect(container).toBeEmptyDOMElement();
  });

  it("stays, and says so, on a page the run did not manage", () => {
    useOcrRun.setState({ run: run({ stored: [0, 1], failed: [4], index: 210 }) });
    scanned();
    show();

    expect(screen.getByText("第 5 页上次没识别成功")).toBeInTheDocument();
    // Both actions survive: 识别全书 re-derives the scan list, so it is now a
    // one-page run over exactly the pages that failed.
    expect(screen.getByRole("button", { name: "识别这一页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "识别全书" })).toBeInTheDocument();
  });
});
