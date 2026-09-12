import type { Annotation } from "@/types/ipc";

import type { TextRange } from "./selection";

/**
 * Selection and highlight bookkeeping for the pdf.js text layer.
 *
 * The layer renders each text item as an absolutely positioned `<span>`.
 * Annotation offsets are UTF-16 counts into the layer's joined span text in
 * DOM order — the same coordinate style the prose path uses, with the page's
 * layer standing in for the chapter's paragraphs. DOM order follows the
 * content stream, so the mapping is stable across sessions on one pdf.js
 * version; only `annotation.text` is consumed elsewhere, so a pdf.js upgrade
 * re-bases offsets at worst and nothing desyncs.
 */

interface NodeStart {
  node: Text;
  start: number;
}

interface LayerWalk {
  text: string;
  nodes: NodeStart[];
}

function walkLayer(container: HTMLElement): LayerWalk {
  // Visual order, not DOM order: the content stream regularly paints text out
  // of reading order (Word/LaTeX exports move floats, footers, whole runs),
  // and a visually downward drag must resolve to the text below — not to
  // whatever the stream happened to emit first. Spans are bucketed by top
  // (8px, absorbs per-font ascent jitter) then read left to right; annotation
  // offsets share this walk, so paint and resolve stay consistent.
  const spans = Array.from(container.querySelectorAll<HTMLElement>("span")).filter(
    (span) => !span.classList.contains("markedContent") && (span.textContent?.length ?? 0) > 0,
  );
  const ordered = spans
    .map((span) => {
      const rect = span.getBoundingClientRect();
      return { span, top: Math.round(rect.top / 8), left: rect.left };
    })
    .toSorted((a, b) => a.top - b.top || a.left - b.left);

  const nodes: NodeStart[] = [];
  let text = "";
  for (const { span } of ordered) {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node: node as Text, start: text.length });
      text += node.textContent ?? "";
    }
  }
  return { text, nodes };
}

function joinedOffset(nodes: NodeStart[], container: Node, offset: number): number | null {
  // Linear scan: layers hold a few hundred nodes and selections are rare.
  const at = nodes.findIndex((entry) => entry.node === container);
  return at < 0 ? null : nodes[at]!.start + offset;
}

function nodeAndOffset(nodes: NodeStart[], offset: number): { node: Text; at: number } | null {
  let lo = 0;
  let hi = nodes.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid]!.start <= offset) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const entry = nodes[at];
  return entry ? { node: entry.node, at: offset - entry.start } : null;
}

/** Resolves a DOM selection inside one page's text layer into a range of the
 *  layer's joined text, or `null` when collapsed or outside the layer. */
export function resolveLayerSelection(
  container: HTMLElement,
  selection: Selection,
): TextRange | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const { text, nodes } = walkLayer(container);
  const start = joinedOffset(nodes, range.startContainer, range.startOffset);
  const end = joinedOffset(nodes, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end, text: text.slice(start, end) };
}

/** UTF-16 offset in the layer's joined text under a viewport point, or `null`
 *  when the point misses the layer. */
export function layerOffsetAtPoint(x: number, y: number, container: HTMLElement): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (!position) return null;
    node = position.offsetNode;
    offset = position.offset;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  } else {
    return null;
  }
  if (!node || !container.contains(node)) return null;
  const { nodes } = walkLayer(container);
  return joinedOffset(nodes, node, offset);
}

/** Paints the page's annotations with the CSS Custom Highlight API. All
 *  mounted pages share one highlight name: each page keeps its own ranges and
 *  every repaint rebuilds the union. Pages without Highlight support (none
 *  today, but the API is young) skip painting silently — the annotation
 *  drawer stays the source of truth. */
const HIGHLIGHT_NAME = "pdf-notes";
const painted = new Map<number, Range[]>();

function repaint() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const all: Range[] = [];
  for (const ranges of painted.values()) all.push(...ranges);
  if (all.length === 0) {
    CSS.highlights.delete(HIGHLIGHT_NAME);
  } else {
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...all));
  }
}

export function paintPageHighlights(
  pageNumber: number,
  container: HTMLElement,
  annotations: Annotation[],
): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const { nodes } = walkLayer(container);
  const ranges: Range[] = [];
  for (const annotation of annotations) {
    if (annotation.endChar <= annotation.startChar) continue;
    const from = nodeAndOffset(nodes, annotation.startChar);
    const to = nodeAndOffset(nodes, annotation.endChar);
    if (!from || !to) continue;
    const range = new Range();
    range.setStart(from.node, from.at);
    range.setEnd(to.node, to.at);
    ranges.push(range);
  }
  painted.set(pageNumber, ranges);
  repaint();
}

export function clearPageHighlights(pageNumber: number): void {
  if (!painted.delete(pageNumber)) return;
  repaint();
}

/**
 * The read-aloud wash. One range at a time across every mounted page, in its
 * own highlight name so it never mixes with saved annotations — the prose
 * path's wash and this one are the same colour by intent: the line being
 * read looks the same whichever format is speaking it.
 */
const TTS_NAME = "pdf-tts";
let ttsRange: Range | null = null;

function repaintTts() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (ttsRange === null) {
    CSS.highlights.delete(TTS_NAME);
  } else {
    CSS.highlights.set(TTS_NAME, new Highlight(ttsRange));
  }
}

/** Non-whitespace characters before `raw`, i.e. the offset's position in the
 *  whitespace-collapsed string. */
function compactAt(value: string, raw: number): number {
  let count = 0;
  for (let at = 0; at < raw && at < value.length; at += 1) {
    if (!/\s/.test(value[at]!)) count += 1;
  }
  return count;
}

/** The value with every whitespace run removed, plus a map from each
 *  surviving character back to its raw offset. */
function collapse(value: string): { compact: string; map: number[] } {
  const map: number[] = [];
  let compact = "";
  for (let at = 0; at < value.length; at += 1) {
    const ch = value[at]!;
    if (!/\s/.test(ch)) {
      map.push(at);
      compact += ch;
    }
  }
  return { compact, map };
}

/** Locates `needle` in the layer's joined text and resolves the span
 *  `from..to` (offsets inside the needle) to real layer offsets.
 *
 *  The spoken text comes from the extraction pipeline, the layer from pdf.js's
 *  own: the two disagree on whitespace (pdf.js emits one space per text item)
 *  and occasionally on reading order. An exact match is tried first; the
 *  fallback compares with every whitespace run collapsed, carrying `from..to`
 *  across the collapse on both sides. */
export function locateLayerText(
  container: HTMLElement,
  needle: string,
  from: number,
  to: number,
): { start: number; end: number } | null {
  if (needle.length === 0 || from < 0 || to > needle.length || to <= from) return null;
  const { text } = walkLayer(container);
  const direct = text.indexOf(needle);
  if (direct >= 0) return { start: direct + from, end: direct + to };
  const layer = collapse(text);
  const mark = collapse(needle);
  if (mark.compact.length === 0) return null;
  const hit = layer.compact.indexOf(mark.compact);
  if (hit < 0) return null;
  const start = layer.map[hit + compactAt(needle, from)];
  const lastChar = layer.map[hit + compactAt(needle, to) - 1];
  if (start === undefined || lastChar === undefined) return null;
  return { start, end: lastChar + 1 };
}

/** Paints the read-aloud wash over real layer offsets and brings the line
 *  into view. `nearest` never yanks a visible line, matching the prose
 *  path's follow behaviour; word-level repaints therefore don't jitter. */
export function paintTtsWash(container: HTMLElement, start: number, end: number): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const { nodes, text } = walkLayer(container);
  const from = nodeAndOffset(nodes, Math.max(0, Math.min(start, text.length)));
  const to = nodeAndOffset(nodes, Math.max(0, Math.min(end, text.length)));
  if (!from || !to) return;
  const range = new Range();
  range.setStart(from.node, Math.min(from.at, from.node.length));
  range.setEnd(to.node, Math.min(to.at, to.node.length));
  ttsRange = range;
  repaintTts();
  range.startContainer.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Drops the read-aloud wash — the voice stopped, or its page unmounted. */
export function clearTtsWash(): void {
  if (ttsRange === null) return;
  ttsRange = null;
  repaintTts();
}
