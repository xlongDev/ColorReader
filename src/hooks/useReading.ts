import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import { demoEnabled, demoReadingStats } from "@/lib/demo";
import { useReaderSettings, updateReadingSpeed } from "@/stores/reader";
import { foldPace, NO_PACE, type PaceSample } from "@/features/reader/pace";

/**
 * Reading time: what the stats page reads and what the reader reports.
 *
 * The reader is the only writer. Elapsed wall-clock seconds accumulate in one
 * Rust row per (book, local day), so this side never has to remember a session
 * start: it only has to notice that the reader is still on the page.
 *
 * [`useReadingPace`] is the other half of the same question — not *how long*
 * the reader has been here, but *how fast* they are going through it.
 */

/** How often accumulated time is handed to the backend. */
const FLUSH_MS = 60_000;
/** Batches below this are noise (a page opened and closed at once). */
const MIN_BATCH_SECONDS = 5;

/** Today, this week, the streak and the days behind the heat map. */
export function useReadingStats() {
  return useQuery({
    queryKey: ["reading", "stats"],
    queryFn: () => {
      if (demoEnabled()) return Promise.resolve(demoReadingStats);
      return ipc.statsReading();
    },
    staleTime: 30_000,
  });
}

function useInvalidateReading() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["reading"] });
}

/** Adds one batch of reading time. Fire and forget: a lost batch costs a
 *  minute of history, which is not worth an error state. */
function useRecordSession() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (input: { bookId: string; seconds: number }) =>
      ipc.statsRecordSession(input.bookId, input.seconds),
    onSuccess: invalidate,
  });
}

/**
 * Drops every reading-time row.
 *
 * The page asks first; this is the doing. Not silent-failing like the recorder:
 * a reader who asked to clear and did not has to be told.
 */
export function useClearReadingStats() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: () => ipc.statsClear(),
    onSuccess: invalidate,
  });
}

/**
 * Sustained reading speed, reported one progress save at a time.
 *
 * The reader owns the clock and only ever knows one number — how many
 * characters into the book it is — so this takes that number and folds the
 * delta into both estimators: the running average the remaining-time label
 * falls back on, and the median window that takes over once there are
 * stretches to take a middle one from. `pace.ts` explains why there are two.
 *
 * Called from the reader's own save path rather than from an effect of its
 * own, because a save *is* the end of a reading stretch: the place where the
 * reader's position is known and the clock is honest.
 *
 * The open stretch is a ref on purpose: it changes on every save, and a store
 * write per save is a write of the whole persisted settings blob, custom paper
 * included.
 */
export function useReadingPace(): (charsNow: number) => void {
  const readingSpeed = useReaderSettings((s) => s.readingSpeed);
  const setReadingSpeed = useReaderSettings((s) => s.setReadingSpeed);
  const recordPace = useReaderSettings((s) => s.recordPace);
  /** Where the reader was last time, and when. */
  const lastRef = useRef<{ at: number; chars: number } | null>(null);
  /** The stretch the median is still folding into. */
  const stretchRef = useRef<PaceSample>(NO_PACE);

  return useCallback(
    (charsNow: number) => {
      const sample = { at: Date.now(), chars: charsNow };
      const last = lastRef.current;
      lastRef.current = sample;
      if (!last) return;
      const read = charsNow - last.chars;
      const elapsed = sample.at - last.at;
      const next = updateReadingSpeed(readingSpeed, read, elapsed);
      if (next !== readingSpeed) setReadingSpeed(next);
      // The same delta, folded into the median window. The average above is
      // what the label says for the first few minutes; this is what it says
      // once there are stretches to take a middle one from.
      const folded = foldPace(stretchRef.current, read, elapsed);
      stretchRef.current = folded.acc;
      if (folded.sample) recordPace(folded.sample);
    },
    [readingSpeed, recordPace, setReadingSpeed],
  );
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
