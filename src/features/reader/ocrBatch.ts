/**
 * Driving a whole-book OCR run, one page at a time.
 *
 * The loop lives here, in the frontend, and not in Rust — which is the one
 * thing about this file worth explaining. Rendering a page is `pdfOcr.ts`, a
 * pdf.js call in the webview; Rust has no PDF renderer. A batch loop on the
 * Rust side would therefore have to call *back* into the frontend for every
 * single image, which is an event protocol to build, debug and version in
 * exchange for nothing. Running the loop here makes progress plain React state
 * instead of a stream of events, and leaves Rust with the two things only it
 * can answer: which pages still need recognising, and storing the answer.
 *
 * Three rules decide the shape:
 *
 * - **One bad page does not end the run.** A two-hundred-page run that stops at
 *   page three because the provider hiccuped once is a run nobody can finish.
 *   A failure is recorded and the next page starts.
 *
 * - **Cancel is checked between pages, never inside one.** The answer to an
 *   in-flight request has already been paid for; dropping it would mean paying
 *   for that page twice on resume. So the page in progress always finishes, and
 *   the worst case a cancel waits is one round trip.
 *
 * - **A stopped run is resumable with no bookkeeping.** The list of pages is
 *   derived from the corpus, not remembered, so pressing the button again picks
 *   up exactly what is left — including whatever just failed.
 *
 * There is deliberately no pacing between requests. A vision call carries a
 * megabyte up and waits for an answer, so the loop is already spaced by seconds;
 * a fixed sleep would turn a fifteen-minute run into a twenty-five-minute one to
 * guard against a limit that most providers do not impose. A provider that does
 * throttle answers with a failure, and a failure is a page that comes back on
 * the next press.
 */

/** How far along a run is, reported before each page is started. */
export interface OcrBatchProgress {
  /** 1-based position in this run: "第 3 页，共 210 页". */
  index: number;
  total: number;
}

/**
 * What a run left behind.
 *
 * Two lists rather than two counts, because the caller needs to know *which*
 * pages landed: a page the run recognised must stop offering its 识别 button,
 * and a page that failed must keep it. Counts are `length`.
 */
export interface OcrBatchResult {
  /** Pages whose text was stored, in the order they were tried, 0-based. */
  stored: number[];
  /** Pages that failed, in the order they were tried, 0-based. */
  failed: number[];
  /** True when the run stopped early because the caller asked it to. */
  cancelled: boolean;
}

export interface OcrBatchDeps {
  /**
   * Renders one page (0-based) and gets its text stored; resolving means it
   * landed. Rendering and sending are one call because nothing here needs them
   * apart — a page fails as a page, whichever half broke. The character count
   * the command reports back is dropped: a run is counted in pages, and a page
   * that stores nothing at all is already a failure (`ocr::write_page`).
   */
  recognisePage: (page: number) => Promise<void>;
  /** Called before each page, so the counter names the page being worked on. */
  onProgress?: (progress: OcrBatchProgress) => void;
  /**
   * Read between pages. A function, not a value: the caller's flag is set from
   * a click handler and must be seen by a loop that is already running.
   */
  isCancelled?: () => boolean;
}

/**
 * Recognises `pages` in order and reports what happened.
 *
 * The invariant callers can rely on: `stored.length + failed.length` is how
 * many pages were attempted, which is every page when `cancelled` is false.
 */
export async function runOcrBatch(
  pages: readonly number[],
  { recognisePage, onProgress, isCancelled }: OcrBatchDeps,
): Promise<OcrBatchResult> {
  const total = pages.length;
  const stored: number[] = [];
  const failed: number[] = [];

  for (const [index, page] of pages.entries()) {
    // Top of the loop, so this covers cancelling before the first page as well
    // as between two of them.
    if (isCancelled?.()) return { stored, failed, cancelled: true };

    onProgress?.({ index: index + 1, total });

    try {
      await recognisePage(page);
      stored.push(page);
    } catch {
      // Swallowed on purpose: the page keeps its empty body, so it stays on the
      // scan list and the reader's next press finds it. There is nothing to
      // report that "这一页没成功" does not already say.
      failed.push(page);
    }
  }

  return { stored, failed, cancelled: false };
}
