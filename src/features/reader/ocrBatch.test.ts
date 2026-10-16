import { describe, expect, it, vi } from "vitest";

import { runOcrBatch, type OcrBatchProgress } from "@/features/reader/ocrBatch";

/** A run whose every page succeeds, recording the order they were tried in. */
function runner(
  options: {
    /** Pages that should throw when reached. */
    fails?: readonly number[];
    /** Sets the cancel flag once this page has been stored. */
    cancelAfter?: number;
  } = {},
) {
  const tried: number[] = [];
  const progress: OcrBatchProgress[] = [];
  let cancelled = false;

  const result = (pages: readonly number[]) =>
    runOcrBatch(pages, {
      recognisePage: async (page) => {
        tried.push(page);
        if (options.fails?.includes(page)) throw new Error("这一页没成功");
        if (page === options.cancelAfter) cancelled = true;
      },
      onProgress: (update) => progress.push(update),
      isCancelled: () => cancelled,
    });

  return { result, tried, progress };
}

describe("runOcrBatch", () => {
  it("visits every page in order and counts what was stored", async () => {
    const { result, tried } = runner();
    const outcome = await result([0, 2, 3, 7]);

    expect(tried).toEqual([0, 2, 3, 7]);
    expect(outcome).toEqual({ stored: [0, 2, 3, 7], failed: [], cancelled: false });
  });

  it("names the page it is about to work on, before working on it", async () => {
    const { result, progress } = runner();
    await result([4, 5, 6]);

    // Before, not after: the counter exists to say what is happening *now*, and
    // a report written once the page finished would leave the reader looking at
    // "第 0 页" for the whole of the first request.
    expect(progress).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ]);
  });

  it("keeps going after a page fails, and names it", async () => {
    const { result, tried } = runner({ fails: [2] });
    const outcome = await result([0, 2, 3]);

    // All three, and the two that worked in the order they were tried.
    expect(tried).toEqual([0, 2, 3]);
    expect(outcome.failed).toEqual([2]);
    expect(outcome.stored).toEqual([0, 3]);
    expect(outcome.cancelled).toBe(false);
  });

  it("stops between pages when cancelled, keeping what it had", async () => {
    // Cancelled after page 5: 0, 3 and 5 are stored and 8 is never started.
    const { result, tried } = runner({ cancelAfter: 5 });
    const outcome = await result([0, 3, 5, 8]);

    // 8 is never started.
    expect(tried).toEqual([0, 3, 5]);
    expect(outcome).toEqual({ stored: [0, 3, 5], failed: [], cancelled: true });
  });

  it("lets the page in flight finish before it stops", async () => {
    // The cancel lands *during* page 1 — the flag is set from a click handler
    // while the request is out. That answer has already been paid for, so it is
    // counted; abandoning it would mean paying for this page twice on resume.
    let cancelled = false;
    const tried: number[] = [];

    const outcome = await runOcrBatch([1, 2], {
      recognisePage: async (page) => {
        tried.push(page);
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });

    // Page 1 ran to the end; page 2 was never started.
    expect(tried).toEqual([1]);
    expect(outcome).toEqual({ stored: [1], failed: [], cancelled: true });
  });

  it("sends nothing when cancelled before the first page", async () => {
    const tried: number[] = [];
    const outcome = await runOcrBatch([0, 1], {
      recognisePage: async (page) => {
        tried.push(page);
      },
      isCancelled: () => true,
    });

    expect(tried).toEqual([]);
    expect(outcome).toEqual({ stored: [], failed: [], cancelled: true });
  });

  it("accounts for every attempted page as stored or failed", async () => {
    // The invariant the store leans on, and the one that makes a stopped run
    // resumable: what is left is `pages` minus what succeeded, and the corpus
    // derives that same list with nothing remembered here.
    const { result } = runner({ fails: [1], cancelAfter: 4 });
    const outcome = await result([1, 4, 9]);

    expect([...outcome.stored, ...outcome.failed].toSorted()).toEqual([1, 4]);
    expect(outcome.failed).toEqual([1]);
    expect(outcome.cancelled).toBe(true);
  });
});

describe("runOcrBatch without the optional callbacks", () => {
  it("runs to the end with neither a progress sink nor a cancel flag", async () => {
    const outcome = await runOcrBatch([0, 1], { recognisePage: async () => {} });
    expect(outcome).toEqual({ stored: [0, 1], failed: [], cancelled: false });
  });
});

describe("runOcrBatch error handling", () => {
  it("treats any thrown value as a page failure, not a crash", async () => {
    const recognisePage = vi.fn(async (page: number) => {
      // Providers throw strings, objects and Errors depending on the layer.
      if (page === 0) throw "字符串错误";
      if (page === 1) throw { message: "对象错误" };
    });

    const outcome = await runOcrBatch([0, 1, 2], { recognisePage });
    expect(outcome.failed).toEqual([0, 1]);
    expect(outcome.stored).toEqual([2]);
  });
});
