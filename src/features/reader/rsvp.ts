/**
 * Rapid Serial Visual Presentation: one word at a time, in one place.
 *
 * The eye does not sweep a line when it reads — it jumps, four or five times a
 * second, and most of what a reader pays for a line is the sweep, not the
 * word. RSVP removes the sweep: every word appears in the same spot, the eye
 * never moves, and the speed is set by how fast the words come rather than by
 * how fast the eye can travel.
 *
 * Two details decide whether it works:
 *
 * - **The word is placed on its focus letter, not centred.** A centred word
 *   moves its own middle every time the word length changes, which is a sweep
 *   in disguise. Aligning one letter — a third of the way in, roughly — keeps
 *   the eye on the same pixel and lets the rest of the word be read off to the
 *   side.
 * - **Punctuation gets time.** A sentence end is a breath: the reader is
 *   assembling what they just read, and a word arriving at the same rate as
 *   every other word drops the thread. So a token ending in 。 or ！ waits.
 */

/** Slowest and fastest the words come, and where they start. */
export const MIN_WPM = 120;
export const MAX_WPM = 900;
export const DEFAULT_WPM = 300;

/** Characters that end a sentence, in either script. */
const SENTENCE_END = /[。！？!?…；;。.]$/;
/** Characters that end a clause: a shorter breath than a sentence. */
const CLAUSE_END = /[，、：:,）)"」』—]$/;

/** Longest token shown as one flash; past this it is cut. */
const MAX_TOKEN = 24;

type SegmenterCtor = new (
  locale?: string,
  options?: { granularity: string },
) => {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};

const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;

/**
 * Words and their attached punctuation, in order.
 *
 * `Intl.Segmenter` does the cutting where it exists, which is the difference
 * between this working for Chinese and not: a whitespace split leaves a whole
 * CJK sentence as one unreadable token. Trailing punctuation rides with the
 * word before it rather than flashing on its own — a lone 。 is a frame of
 * nothing.
 *
 * Without a segmenter the fallback is a whitespace split, which still works
 * for every Latin-script book; a CJK one simply reads in longer units.
 */
export function rsvpTokens(text: string): string[] {
  const parts = Segmenter
    ? [...new Segmenter("zh", { granularity: "word" }).segment(text)]
        .map((part) => part.segment)
        .filter((part) => part.trim() !== "")
    : text.split(/\s+/).filter(Boolean);

  const tokens: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    // A run of marks with no word of its own belongs to the word before it.
    const last = tokens.at(-1);
    if (last && !/[\p{L}\p{N}]/u.test(trimmed)) {
      tokens[tokens.length - 1] = last + trimmed;
      continue;
    }
    for (const piece of chunk(trimmed)) tokens.push(piece);
  }
  return tokens;
}

/** Cuts a token no segmenter would have — long runs with no break in them. */
function chunk(token: string): string[] {
  if (token.length <= MAX_TOKEN) return [token];
  const out: string[] = [];
  for (let i = 0; i < token.length; i += MAX_TOKEN) {
    out.push(token.slice(i, i + MAX_TOKEN));
  }
  return out;
}

/**
 * Index of the letter the word is aligned on.
 *
 * The classic ORP curve: a third of the way in for a short word, creeping
 * forward as the word grows. For Chinese the distinction is decorative — a
 * two-character word is two glyphs either way — but it costs nothing and it is
 * what makes long English words readable at speed.
 */
export function focusIndex(token: string): number {
  const length = [...token].length;
  if (length <= 1) return 0;
  if (length <= 5) return 1;
  if (length <= 9) return 2;
  if (length <= 13) return 3;
  return 4;
}

/** Milliseconds a token stays on screen at `wpm` words per minute. */
export function tokenDelayMs(token: string, wpm: number): number {
  const base = 60_000 / Math.max(wpm, 1);
  // Longer words take longer to recognise, but only a little: weight is the
  // reason a 12-letter word is slower, not a reason to halve the rate.
  const weight = 1 + Math.min(Math.max([...token].length - 5, 0), 8) * 0.03;
  const breath = SENTENCE_END.test(token) ? 2 : CLAUSE_END.test(token) ? 1.4 : 1;
  return Math.round(base * weight * breath);
}

/** Seconds left in a run of `tokens` from `index`, at `wpm`. */
export function remainingSeconds(tokens: number, index: number, wpm: number): number {
  const left = Math.max(0, tokens - index);
  return Math.round((left / Math.max(wpm, 1)) * 60);
}
