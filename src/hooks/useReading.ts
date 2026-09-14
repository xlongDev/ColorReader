import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { ReadingStats } from "@/types/ipc";

/**
 * Reading time: what the stats page reads and what the reader reports.
 *
 * The reader is the only writer. Elapsed wall-clock seconds accumulate in one
 * Rust row per (book, local day), so this side never has to remember a session
 * start: it only has to notice that the reader is still on the page.
 */

/** Browser dev mode has no backend and no history; the page shows zeroes. */
const EMPTY: ReadingStats = {
  todaySeconds: 0,
  weekSeconds: 0,
  totalSeconds: 0,
  streak: 0,
  daysRead: 0,
  days: [],
};

/** How often accumulated time is handed to the backend. */
const FLUSH_MS = 60_000;
/** Batches below this are noise (a page opened and closed at once). */
const MIN_BATCH_SECONDS = 5;

/** Today, this week, the streak and the days behind the heat map. */
export function useReadingStats() {
  return useQuery({
    queryKey: ["reading", "stats"],
    queryFn: () => (isDesktopRuntime ? ipc.statsReading() : Promise.resolve(EMPTY)),
    staleTime: 30_000,
  });
}

function useInvalidateReading() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["reading"] });
}

/** Adds one batch of reading time. Fire and forget: a lost batch costs a
 *  minute of history, which is not worth an error state. */
export function useRecordSession() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (input: { bookId: string; seconds: number }) =>
      isDesktopRuntime ? ipc.statsRecordSession(input.bookId, input.seconds) : Promise.resolve(),
    onSuccess: invalidate,
  });
}

/**
 * Reports reading time while `bookId` is open.
 *
 * Time counts only while the document is visible, and the residual batch is
 * flushed when the reader unmounts or the book changes, so closing the app
 * mid-minute keeps what was read. The interval is the only timer: a per-second
 * tick would wake the web view 60 times more often for no extra accuracy.
 */
export function useReadingClock(bookId: string | null): void {
  const { mutate: record } = useRecordSession();

  useEffect(() => {
    if (!bookId) return;
    let elapsed = 0;
    let since = Date.now();
    let hidden = document.hidden;

    /** Moves the time since the last tick into `elapsed`. Hidden time is
     *  dropped rather than banked: a reader who leaves the window open all
     *  night did not read all night. */
    const settle = () => {
      const now = Date.now();
      if (!hidden) elapsed += now - since;
      since = now;
    };
    /** Banks the run up to the change under the *old* state: hiding keeps what
     *  was read before it, showing throws the whole hidden stretch away. */
    const onVisibility = () => {
      settle();
      hidden = document.hidden;
    };
    const flush = () => {
      settle();
      const seconds = Math.round(elapsed / 1000);
      elapsed = 0;
      if (seconds >= MIN_BATCH_SECONDS) record({ bookId, seconds });
    };

    const timer = window.setInterval(flush, FLUSH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [bookId, record]);
}
