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
