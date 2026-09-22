/**
 * Reading pace as a median over finished stretches, not a running average.
 *
 * The remaining-time label is an estimate of how long the reader has left, and
 * the one thing that reliably wrecks it is the stretch where they were not
 * reading at all: the app stayed open, the book stayed put, and ten minutes
 * went into the average at fifty characters. An average cannot tell that apart
 * from a slow reader — it just pulls every future estimate towards it, and it
 * keeps pulling for as long as the outlier is in the window.
 *
 * A median can: one idle stretch among forty is a sample the median never
 * looks at. So pace is kept as a bounded window of *finished* stretches, and
 * the estimate is the middle one.
 *
 * Two rules decide what a stretch is:
 *
 * - It has to be long enough to mean something (ten seconds and two hundred
 *   characters). Anything shorter is noise about the reader's scrolling, not
 *   about their reading.
 * - A stretch whose clock ran while the text did not is thrown away rather
 *   than recorded. That is the whole point: the estimate is of *reading* time,
 *   and a minute with nothing read in it is not a slow minute, it is no minute.
 *
 * The window is deliberately short (forty). A reader's pace is not a constant
 * — it moves with the book, the hour and the day — and a window that took a
 * hundred stretches to turn over would spend most of its life describing
 * someone who is not reading this book right now.
 */

/** One finished reading stretch. */
export interface PaceSample {
  chars: number;
  ms: number;
}

/** How many stretches the median is taken over. */
export const PACE_WINDOW = 40;

/** A stretch has to reach both of these before it counts. */
const MIN_SAMPLE_MS = 10_000;
const MIN_SAMPLE_CHARS = 200;

/** A delta this long with this little read in it is the reader being away. */
const IDLE_MS = 60_000;
const IDLE_CHARS = 50;

/** Plausible reading paces, in characters per minute. Outside this band a
 *  stretch is a measurement error — a jump, a search, a chapter skipped —
 *  not a reader. */
const MIN_CPM = 60;
const MAX_CPM = 2_000;

/** Stretches needed before the median outranks the prior. One stretch is an
 *  anecdote; five is a reading session. */
export const MIN_PACE_SAMPLES = 5;

/** An empty accumulator. */
export const NO_PACE: PaceSample = { chars: 0, ms: 0 };

/**
 * Folds one delta into the open stretch, closing it when it is complete.
 *
 * Returns the closed sample, or `null` while the stretch is still open.
 * Statutory warning: `chars` and `ms` are a *delta* since the last fold, not
 * running totals — the caller owns the clock, this only owns the window.
 */
export function foldPace(
  acc: PaceSample,
  chars: number,
  ms: number,
): { acc: PaceSample; sample: PaceSample | null } {
  if (ms <= 0) return { acc, sample: null };
  // The clock ran, the text did not: the reader was somewhere else. Dropping
  // the whole open stretch is what makes the median worth taking — recording
  // it would put the average's problem back in through the window.
  if (ms >= IDLE_MS && chars <= IDLE_CHARS) return { acc: NO_PACE, sample: null };

  const next = { chars: acc.chars + Math.max(0, chars), ms: acc.ms + ms };
  if (next.chars >= MIN_SAMPLE_CHARS && next.ms >= MIN_SAMPLE_MS) {
    return { acc: NO_PACE, sample: next };
  }
  return { acc: next, sample: null };
}

/** Adds a closed stretch to the window, dropping the oldest past its size. */
export function pushPace(samples: readonly PaceSample[], sample: PaceSample): PaceSample[] {
  const next = [...samples, sample];
  return next.length > PACE_WINDOW ? next.slice(next.length - PACE_WINDOW) : next;
}

/**
 * Characters per minute at the median stretch, or `null` while there is not
 * enough to take one.
 *
 * Implausible stretches are dropped rather than clamped: a jump to the last
 * chapter reads as a fantastic pace and a clamped one would still be an
 * outlier sitting in the middle of the window, which is the one place a median
 * cannot ignore.
 */
export function medianCpm(samples: readonly PaceSample[]): number | null {
  const rates = samples
    .filter((sample) => sample.chars > 0 && sample.ms > 0)
    .map((sample) => (sample.chars / sample.ms) * 60_000)
    .filter((cpm) => cpm >= MIN_CPM && cpm <= MAX_CPM)
    .toSorted((a, b) => a - b);
  if (rates.length < MIN_PACE_SAMPLES) return null;
  const mid = rates.length >> 1;
  return rates.length % 2 === 1 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
}
