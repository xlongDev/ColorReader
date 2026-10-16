import { create } from "zustand";

import { pageImageDataUrl } from "@/features/reader/pdfOcr";
import { runOcrBatch } from "@/features/reader/ocrBatch";
import { ipc } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";

/**
 * The whole-book OCR run, which outlives the page that started it.
 *
 * A 756-page scan is about a quarter of an hour of requests, and nobody sits on
 * one page for that — they scroll, open the TOC, or go back to the shelf. A loop
 * owned by a component would be abandoned by the first unmount, halfway through,
 * having already paid for half a book. So the loop lives here, above every
 * component, and the reader's page only starts it and reads its progress.
 *
 * Three consequences worth stating outright:
 *
 * - **The store does the work itself.** It renders each page and sends it. A
 *   caller that handed over a `recognisePage` closure would be handing over a
 *   function that dies with the component that made it, which is the whole
 *   thing this exists to avoid.
 *
 * - **Completion is announced by a toast, raised from here.** Nothing is mounted
 *   when a fifteen-minute run ends, so there is no component left to report it —
 *   and the reader who walked away is exactly the one who needs telling.
 *
 * - **Nothing is persisted, and nothing should be.** A run is a live process,
 *   not a preference. If the app closes mid-run, the work already stored stays
 *   stored, and the scan list is derived from the corpus — so pressing the
 *   button again resumes exactly where it stopped, with no bookkeeping to
 *   recover.
 *
 * 🔴 **This leans on `loadDoc` keeping the document for the session.** Rendering
 * page 300 of a book whose reader has been unmounted only works because
 * `lib/pdf.ts` caches one `PDFDocumentProxy` per book and never destroys it. If
 * a "release the document when the reader closes" cleanup is ever added, this
 * run starts failing a few pages in, and it will look like the provider's fault.
 */
export type OcrRunStatus = "running" | "stopping" | "done";

export interface OcrRun {
  bookId: string;
  /** How many pages this run set out to do. */
  total: number;
  /** How far it got: 1-based position of the page being worked on, and once the
   *  run is done, how many pages it attempted (which is below `total` when the
   *  reader stopped it). */
  index: number;
  /** 0-based pages that gained text. */
  stored: number[];
  /** 0-based pages that did not, in the order they were tried. */
  failed: number[];
  status: OcrRunStatus;
}

interface OcrRunState {
  /** The run in flight, or the last one that finished. `null` before any. */
  run: OcrRun | null;
  /** Recognises `pages` of `bookId`, in order. Ignored while a run is live. */
  start: (bookId: string, pages: readonly number[]) => Promise<void>;
  /** Asks the run to stop. The page in flight still finishes — see `ocrBatch`. */
  stop: () => void;
}

/**
 * The stop request, deliberately outside the store.
 *
 * The running loop captured its `isCancelled` at the start and reads it between
 * pages, so the flag has to be a value that outlives every render and every
 * `set` — a field in the store would work only if the loop re-read the store,
 * which is exactly the coupling this avoids.
 */
let stopRequested = false;

export const useOcrRun = create<OcrRunState>()((set, get) => ({
  run: null,

  start: async (bookId, pages) => {
    const current = get().run;
    if (current && current.status !== "done") {
      // One run at a time, and said out loud rather than silently dropped: the
      // second press came from a real button, and a button that does nothing is
      // worse than one that explains itself.
      showToast("error", "另一本书正在识别中，等它结束再开始。");
      return;
    }

    stopRequested = false;
    set({
      run: { bookId, total: pages.length, index: 0, stored: [], failed: [], status: "running" },
    });

    const result = await runOcrBatch(pages, {
      recognisePage: async (page) => {
        // 0-based page to the 1-based one the renderer speaks, then back to the
        // 0-based one the command takes — the only place the two conventions
        // meet, and the reason both numbers are written out here.
        const image = await pageImageDataUrl(bookId, page + 1);
        await ipc.ocrPage(bookId, page, image);
      },
      onProgress: ({ index }) =>
        set((state) => (state.run ? { run: { ...state.run, index } } : {})),
      isCancelled: () => stopRequested,
    });

    const finished: OcrRun = {
      bookId,
      total: pages.length,
      // How far the run got, not how many pages it was given: a stopped run's
      // `index` is what `describeRun` counts, and claiming the full length
      // would make "已识别 40 页" sit next to a counter saying 210.
      index: result.stored.length + result.failed.length,
      stored: result.stored,
      failed: result.failed,
      status: "done",
    };
    set({ run: finished });
    showToast(
      result.failed.length === 0 ? "success" : "error",
      describeRun(finished, result.cancelled),
    );
  },

  stop: () => {
    stopRequested = true;
    set((state) =>
      state.run?.status === "running" ? { run: { ...state.run, status: "stopping" } } : {},
    );
  },
}));

/**
 * What to tell the reader when a run ends.
 *
 * Three cases, and the middle one is the reason this is a function: a run that
 * stopped with two pages missing and a run that finished with two pages missing
 * are the same two pages, but only one of them is the reader's own doing — and
 * telling someone "2 页没成功" about pages they chose not to do is telling them
 * something broke.
 */
export function describeRun(run: OcrRun, cancelled: boolean): string {
  const done = run.stored.length;
  if (cancelled) {
    return done === 0
      ? "已停止，这一本还没有识别出文字。"
      : `已识别 ${done} 页，剩下的可以随时继续。`;
  }
  if (run.failed.length === 0) {
    return `全书 ${run.total} 页都识别完了，检索、朗读与助手现在覆盖整本书。`;
  }
  return `已识别 ${done} 页；${run.failed.length} 页没成功，再按一次会只重试这几页。`;
}
