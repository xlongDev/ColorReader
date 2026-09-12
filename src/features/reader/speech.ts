/**
 * Read-aloud units, shared by both reading paths.
 *
 * The prose path (Rust paragraph extraction) and the Kindle path (foliate
 * blocks) speak the same shape: a unit is one utterance plus the character
 * offsets it covers inside its source, so the caller can wash exactly what the
 * voice is on. A whole-paragraph wash hides the line being read, so the
 * default splits paragraphs into sentences.
 */

/** What the voice washes while it reads. */
export type SpeechGranularity = "sentence" | "word" | "paragraph";

export const SPEECH_GRANULARITIES: { key: SpeechGranularity; label: string }[] = [
  { key: "sentence", label: "句子" },
  { key: "word", label: "词语" },
  { key: "paragraph", label: "段落" },
];

/** One utterance and where it sits in its source block. */
export interface SpeechUnit {
  /** What the voice says: the raw run, trimmed. Kept byte-for-byte identical to
   *  `source.text.slice(start, end)` so an engine-reported `charIndex` inside
   *  it maps straight back onto the page — a collapsed copy would drift. */
  text: string;
  /** Paragraph (prose path) or block (Kindle path) the unit belongs to. */
  source: number;
  /** UTF-16 offsets of the unit inside the source's *raw* text. */
  start: number;
  end: number;
}

/** A block offered to the voice, with its raw text for offset bookkeeping. */
export interface SpeechSource {
  index: number;
  text: string;
}

/**
 * Lifecycle of a read-aloud session.
 *
 * These two are what every engine reports, not what a unit is, so they live
 * here beside the model rather than in the hook: both the platform engine and
 * the Edge engine produce them, and neither has to import the other to name
 * its own output.
 */
export type SpeechStatus = "idle" | "playing" | "paused";

/** Where the engine says the voice is inside the current utterance. */
export interface SpeechBoundary {
  /** Index of the utterance the event belongs to. */
  unit: number;
  /** UTF-16 offset of the word inside the utterance's own text. */
  charIndex: number;
  /** Length of the word; 0 when the engine reports the start only. */
  charLength: number;
}

/**
 * Read-aloud wash inside a book's own iframe, pre-divided by foliate's
 * `--overlayer-highlight-opacity` (0.3, never set inside a section) so the
 * painted alpha lands on the app's `--accent-soft` — the same wash the prose
 * path draws, so the marker looks identical on either path. Kept in step with
 * the two `--accent-soft` values in `src/styles/globals.css`.
 */
export const TTS_WASH_BOOK = {
  dark: "rgba(233, 161, 59, 0.533)",
  light: "rgba(150, 89, 26, 0.4)",
} as const;

/**
 * Trims a run of the raw text down to what the voice actually says, keeping
 * the offsets honest: the leading whitespace HTML pretty-printing leaves in
 * front of a paragraph is dropped from the utterance *and* from its start, so
 * a `charIndex` inside the utterance still lands on the right character.
 */
const trimSpan = (raw: string, start: number): { text: string; start: number; end: number } => {
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  return { text, start: start + lead, end: start + lead + text.length };
};

type SegmenterCtor = new (
  locale?: string,
  options?: { granularity: string },
) => { segment(input: string): Iterable<{ segment: string; index: number }> };

/** `Intl.Segmenter` where the engine has it (WKWebView and Chromium both do). */
const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;

/**
 * Fallback sentence cutter for engines without `Intl.Segmenter`: a run up to
 * and including its terminator, plus any closing quote or bracket. Chinese and
 * Latin terminators are both covered, and a bare newline also ends a sentence
 * so a heading never swallows the paragraph under it.
 */
const SENTENCE_CUTTER = /[^。！？!?…\n]*[。！？!?…]+[”’"'』」）)]*|[^。！？!?…\n]+/g;

/** A half-open `[start, end)` run of a block's text. */
export interface Span {
  start: number;
  end: number;
}

const sentenceSpans = (text: string): Span[] => {
  if (Segmenter) {
    const segmenter = new Segmenter("zh", { granularity: "sentence" });
    return [...segmenter.segment(text)].map(({ index, segment }) => ({
      start: index,
      end: index + segment.length,
    }));
  }
  return [...text.matchAll(SENTENCE_CUTTER)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
};

/**
 * The word around `index`, for engines whose `boundary` events carry no
 * `charLength` — Safari reports the start of a word but not its extent.
 * Returns `null` when the engine has no segmenter, leaving the caller to fall
 * back to the whole sentence.
 */
export function wordAround(text: string, index: number): Span | null {
  if (!Segmenter) return null;
  const segmenter = new Segmenter("zh", { granularity: "word" });
  for (const part of segmenter.segment(text)) {
    if (index >= part.index && index < part.index + part.segment.length) {
      return { start: part.index, end: part.index + part.segment.length };
    }
  }
  return null;
}

/**
 * The span to wash for a `boundary` event: the length the engine reports when
 * it reports one, otherwise the word the offset falls in, otherwise a single
 * character so the mark is never invisible.
 */
export function wordSpanAt(text: string, charIndex: number, charLength: number): Span {
  const at = Math.min(Math.max(charIndex, 0), Math.max(text.length - 1, 0));
  if (charLength > 0) return { start: at, end: Math.min(at + charLength, text.length) };
  return wordAround(text, at) ?? { start: at, end: Math.min(at + 1, text.length) };
}

/**
 * The run to wash for the unit the voice is on: the whole utterance, the word
 * the engine last reported, or — at paragraph level — the entire block the
 * utterance came from.
 *
 * `null` means the engine has not said where the voice is yet. Painting the
 * sentence and snapping down onto the word a moment later reads as a flash,
 * not a highlight, so nothing is washed until the position arrives. Every
 * engine reports one as soon as the voice starts; a voice that reports no
 * boundaries at all hands over its whole utterance instead (see `useTts`).
 *
 * Offsets are block-local, ready to place on the page: the utterance's `start`
 * is where its text begins inside its source block, and the paragraph level
 * needs `block`, that block's own end. `trim` is the head 「朗读此处」 cut off the
 * utterance, which shifts both what the engine's offsets are measured against
 * and where the wash begins.
 */
export function washSpan(
  index: number,
  unit: SpeechUnit,
  boundary: SpeechBoundary | null,
  granularity: SpeechGranularity,
  trim = 0,
  block?: number,
): Span | null {
  if (granularity === "paragraph") return { start: 0, end: block ?? unit.end };
  if (granularity === "sentence") return { start: unit.start + trim, end: unit.end };
  if (boundary === null || boundary.unit !== index) return null;
  const spoken = trim > 0 ? unit.text.slice(trim) : unit.text;
  const span = wordSpanAt(spoken, boundary.charIndex, boundary.charLength);
  return { start: unit.start + trim + span.start, end: unit.start + trim + span.end };
}

/** One word of an utterance, and where it starts. */
export interface WordCue extends Span {
  /** Seconds from the start of the clip. */
  at: number;
}

/**
 * Where each word of `text` sits, given the words an engine timed.
 *
 * Matched forward from a moving cursor rather than by `indexOf` from the top:
 * engines report words in the order they are spoken, and a word that repeats
 * inside one sentence has to map to the occurrence being spoken rather than to
 * the first one.
 *
 * A word the text does not contain is dropped instead of guessed at — an engine
 * that normalises numbers or expands an abbreviation reports words that were
 * never on the page, and inventing an offset would wash the wrong characters.
 */
export function wordCues(text: string, words: readonly { at: number; text: string }[]): WordCue[] {
  const cues: WordCue[] = [];
  let cursor = 0;
  for (const word of words) {
    if (word.text === "") continue;
    const at = text.indexOf(word.text, cursor);
    if (at < 0) continue;
    cursor = at + word.text.length;
    cues.push({ at: word.at, start: at, end: cursor });
  }
  return cues;
}

/**
 * Splits a chapter (or a Kindle section) into utterance units, one per
 * sentence. Empty blocks are dropped: the voice has nothing to say and nothing
 * to wash.
 *
 * The reader's highlight level is deliberately not part of the cut. It decides
 * how much of the text the wash covers, not how the voice is fed, and a level
 * change must not recut the queue the voice is walking: the index it holds
 * would then land on a different run of the same text, which is exactly the
 * jump this avoids.
 */
export function speechUnits(sources: readonly SpeechSource[]): SpeechUnit[] {
  const units: SpeechUnit[] = [];
  for (const source of sources) {
    if (source.text.trim() === "") continue;
    for (const span of sentenceSpans(source.text)) {
      const { text, start, end } = trimSpan(source.text.slice(span.start, span.end), span.start);
      if (text === "") continue;
      units.push({ text, source: source.index, start, end });
    }
  }
  return units;
}

/**
 * Characters per second at rate 1, used to turn a text position into a clock.
 * Web Speech has no timeline to ask — `onboundary` gives characters, not
 * seconds — so both time labels are estimates from length. Tuned on Chinese
 * narration, which is what the default voice (Yunjian) speaks.
 */
const SPEECH_CPS = 5;

/** Estimated seconds of speech for `chars` characters at `rate`. */
export function speechSeconds(chars: number, rate: number): number {
  return Math.round(chars / (SPEECH_CPS * Math.max(rate, 0.1)));
}

/** `m:ss`, or `h:mm:ss` past an hour. Negative input clamps to zero. */
export function formatClock(seconds: number): string {
  const total = Math.max(Math.round(seconds), 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, "0")}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * The utterance "read from here" lands on, plus how far into it the reader's
 * position sits.
 *
 * A reader who selects three words inside a sentence expects those three words
 * to be spoken first, not the whole sentence from its opening character — so
 * the caller trims `trim` characters off the head of the utterance it starts
 * on. `index` is `-1` when nothing follows the position (end of chapter).
 */
export function cursorAt(
  units: readonly SpeechUnit[],
  source: number,
  offset: number,
): { index: number; trim: number } {
  const index = units.findIndex(
    (unit) => unit.source > source || (unit.source === source && unit.end > offset),
  );
  if (index < 0) return { index: -1, trim: 0 };
  const unit = units[index]!;
  // A later block means the offset fell on text this queue never speaks (an
  // image placeholder, say); there is nothing inside a unit to trim.
  if (unit.source !== source) return { index, trim: 0 };
  return { index, trim: Math.max(0, offset - unit.start) };
}

/** The queue from `source`/`offset` on, with the first utterance trimmed to
 *  the reader's exact position (see `cursorAt`). Indices into `source` blocks
 *  are preserved, so the Kindle path can still map a unit back to its block. */
export function unitsFromOffset(
  units: readonly SpeechUnit[],
  source: number,
  offset: number,
): SpeechUnit[] {
  const { index, trim } = cursorAt(units, source, offset);
  if (index < 0) return [];
  const kept: SpeechUnit[] = units.slice(index);
  if (trim <= 0) return kept;
  // Units are already trimmed by `speechUnits`, so a head trim can never leave
  // nothing but whitespace behind.
  const first = kept[0]!;
  kept[0] = { ...first, text: first.text.slice(trim), start: first.start + trim };
  return kept;
}

/** Where the voice sits in its queue: characters already spoken and in total. */
export function queuePosition(
  units: readonly SpeechUnit[],
  index: number | null,
): { spoken: number; total: number } {
  let spoken = 0;
  let total = 0;
  units.forEach((unit, at) => {
    if (index !== null && at < index) spoken += unit.text.length;
    total += unit.text.length;
  });
  return { spoken, total };
}

/**
 * The utterance covering `chars` — the scrubber and both clocks run on
 * characters, since that is the only position Web Speech gives us. A thumb
 * placed by utterance index would sit where the track fill disagrees with it.
 */
export function unitAtChar(units: readonly SpeechUnit[], chars: number): number {
  let acc = 0;
  for (let i = 0; i < units.length; i++) {
    acc += units[i]!.text.length;
    if (chars < acc) return i;
  }
  return Math.max(units.length - 1, 0);
}
