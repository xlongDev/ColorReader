import type { Annotation } from "@/types/ipc";

/**
 * Blows a hex ink back to display strength: a highlight wash must survive
 * both paper colours, so the stored hex stays pure and the renderer knocks it
 * back. Shared by every rendering path (prose marks, foliate overlays, PDF
 * custom highlights) so one colour reads the same everywhere.
 */
export function inkWash(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const rgb = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  if (rgb.some((n) => !Number.isFinite(n))) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/**
 * A chapter's paragraphs are rendered as `<p data-para-idx>` elements and joined
 * with `\n` into one string. Highlight offsets are UTF-16 code-unit counts into
 * that joined string, matching JavaScript's `String#length` and `String#slice`.
 */

/** The single string every offset is measured against. */
export function joinedText(paragraphs: string[]): string {
  return paragraphs.join("\n");
}

/** UTF-16 offset where paragraph `idx` starts in the joined text. */
export function paragraphStart(paragraphs: string[], idx: number): number {
  let offset = 0;
  for (let i = 0; i < idx; i++) offset += paragraphs[i]!.length + 1; // +1 for the '\n'
  return offset;
}

/** A resolved selection: a range into the joined text plus its text. */
export interface TextRange {
  start: number;
  end: number;
  text: string;
}

/**
 * Maps paragraph-local positions onto a range of the joined text. Returns
 * `null` when the range is empty or out of bounds.
 */
export function charRange(
  paragraphs: string[],
  startPara: number,
  startOffset: number,
  endPara: number,
  endOffset: number,
): TextRange | null {
  const full = joinedText(paragraphs);
  const start = paragraphStart(paragraphs, startPara) + startOffset;
  const end = paragraphStart(paragraphs, endPara) + endOffset;
  if (start < 0 || end <= start || end > full.length) return null;
  return { start, end, text: full.slice(start, end) };
}

function paragraphFor(node: Node): HTMLElement | null {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el) {
    if (el instanceof HTMLElement && el.dataset.paraIdx !== undefined) return el;
    el = el.parentNode;
  }
  return null;
}

/** UTF-16 offset of `(container, offset)` within one paragraph's text nodes. */
function offsetIn(paragraph: HTMLElement, container: Node, offset: number): number {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let acc = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === container) return acc + offset;
    acc += (node.textContent ?? "").length;
  }
  return acc;
}

/**
 * Resolves a DOM selection inside an article of `<p data-para-idx>` elements
 * into a range of the chapter's joined text, or `null` when collapsed or outside
 * the article.
 */
export function resolveSelection(selection: Selection, paragraphs: string[]): TextRange | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);

  const startPara = paragraphFor(range.startContainer);
  const endPara = paragraphFor(range.endContainer);
  if (!startPara || !endPara) return null;

  return charRange(
    paragraphs,
    Number(startPara.dataset.paraIdx),
    offsetIn(startPara, range.startContainer, range.startOffset),
    Number(endPara.dataset.paraIdx),
    offsetIn(endPara, range.endContainer, range.endOffset),
  );
}

/**
 * The bottom of the lowest line that actually carries selected text.
 *
 * A range whose end sits on a line break — the reader dragged to the end of a
 * line, or the book's own markup wraps the text with a real newline — reports
 * one extra, zero-width rect on the *following* line. The bounding box then
 * reaches a whole line below the words, and a toolbar anchored to it floats in
 * the middle of the paragraph instead of sitting under the selection. Take the
 * bottom of the lowest rect with width; fall back to the box when the
 * selection is a single collapsed point.
 */
export function selectionBottom(rects: ArrayLike<DOMRect>, box: DOMRect): number {
  let bottom = Number.NEGATIVE_INFINITY;
  for (let at = 0; at < rects.length; at += 1) {
    const rect = rects[at]!;
    if (rect.width > 0) bottom = Math.max(bottom, rect.bottom);
  }
  return bottom === Number.NEGATIVE_INFINITY ? box.bottom : bottom;
}

export interface Segment {
  text: string;
  highlighted: boolean;
  /** The annotation covering this run, if any. Search matches highlight
   *  without owning an annotation, so they stay undefined here. */
  annotationId?: string;
  /** True for the run the read-aloud voice is on right now. */
  tts?: boolean;
}

/** A `[start, end)` run inside one paragraph's own text. */
export type LocalRange = readonly [number, number];

/** A highlight source: a local range plus the annotation that owns it. */
export interface MarkRange {
  range: LocalRange;
  id?: string;
  /** A transient read-aloud run rather than a saved mark. */
  tts?: boolean;
}

/**
 * Splits `text` into runs, marking the parts covered by `ranges`. Highlights
 * never overlap in practice, but a midpoint test keeps the sweep correct even
 * when two of them touch.
 *
 * A read-aloud run wins the midpoint test over an annotation: the voice's
 * position is transient and must stay visible when it reads across a mark.
 */
export function segmentText(text: string, ranges: readonly MarkRange[]): Segment[] {
  if (text.length === 0) return [];
  const clamp = (value: number) => Math.min(Math.max(value, 0), text.length);
  const clamped = ranges
    .map(({ range: [start, end], id, tts }) => ({
      start: clamp(start),
      end: clamp(end),
      id,
      tts: tts === true,
    }))
    .filter(({ start, end }) => start < end);
  if (clamped.length === 0) return [{ text, highlighted: false }];

  const cuts = new Set<number>([0, text.length]);
  for (const { start, end } of clamped) {
    cuts.add(start);
    cuts.add(end);
  }
  const points = [...cuts].toSorted((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to <= from) continue;
    const mid = (from + to) >> 1;
    const marked = clamped.find(({ start, end, tts }) => !tts && mid >= start && mid < end);
    // An annotation run keeps its ink and its click target even while the voice
    // reads across it, so the id is resolved independently of the wash.
    const annotationId = clamped.find(
      ({ start, end, id, tts }) => !tts && id !== undefined && mid >= start && mid < end,
    )?.id;
    const spoken = clamped.some(({ start, end, tts }) => tts && mid >= start && mid < end);
    segments.push({
      text: text.slice(from, to),
      highlighted: marked !== undefined,
      ...(annotationId !== undefined ? { annotationId } : {}),
      ...(spoken ? { tts: true } : {}),
    });
  }
  return segments;
}

/** Every case-insensitive occurrence of `query` inside `text`. */
export function matchRanges(text: string, query: string): LocalRange[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const haystack = text.toLowerCase();
  const ranges: LocalRange[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}

/**
 * Segments for one paragraph: this chapter's annotations plus, while a search
 * is open, every occurrence of `query`, plus — when the voice is reading this
 * paragraph — the run it is on.
 */
export function highlightSegments(
  paragraphs: string[],
  idx: number,
  annotations: Annotation[],
  query: string,
  speech?: { start: number; end: number },
): Segment[] {
  const text = paragraphs[idx] ?? "";
  if (text.length === 0) return [];
  const localStart = paragraphStart(paragraphs, idx);
  const ranges: MarkRange[] = annotations.map((annotation) => ({
    range: [annotation.startChar - localStart, annotation.endChar - localStart],
    id: annotation.id,
  }));
  if (query.trim().length > 0) {
    ranges.push(...matchRanges(text, query).map((range) => ({ range })));
  }
  if (speech) ranges.push({ range: [speech.start, speech.end], tts: true });
  return segmentText(text, ranges);
}

/** Index of the paragraph containing `offset` in the joined text. */
export function paragraphAt(paragraphs: string[], offset: number): number {
  let start = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const end = start + paragraphs[i]!.length;
    if (offset <= end) return i;
    start = end + 1;
  }
  return Math.max(0, paragraphs.length - 1);
}
