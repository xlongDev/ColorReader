/**
 * An XHTML document into the paragraphs the shelf stores.
 *
 * The desktop does this in Rust (`document::html`, a forward pass over the
 * bytes). Here the document is already parsed — foliate hands over a
 * `Document` — so it is the same rules walked over a tree instead of a stream:
 * the same elements are skipped, the same set closes a paragraph, a heading is
 * a paragraph too, and whitespace collapses to single spaces.
 *
 * 🔴 The two have to agree, because the chapter table means the same thing on
 * both sides. A chapter's index addresses it for search hits, for read-aloud,
 * and for the progress bar; an epub that split into 40 chapters on the desktop
 * and 39 here would put the reader in a different place depending on which
 * build they opened.
 *
 * `ponytail:` the desktop also emits a marker paragraph per image (U+FFFC) and
 * per in-book link (U+FFFB), because *its* renderer turns those into images and
 * anchors. Nothing here consumes them: foliate draws the images itself, and a
 * link between two sections has no path to resolve from this side. So they are
 * left out rather than written as characters a reader would hear read aloud.
 */

/** Elements that hold no prose. */
const SKIPPED = new Set(["style", "script", "head", "svg", "math"]);

/** Elements whose close ends a paragraph, as on the desktop. */
const BLOCK = new Set([
  "p",
  "div",
  "li",
  "blockquote",
  "tr",
  "td",
  "th",
  "section",
  "article",
  "pre",
  "figure",
  "figcaption",
  "header",
  "footer",
  "aside",
  "main",
  "ul",
  "ol",
  "table",
  "body",
  "html",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const HEADING = /^h[1-6]$/;

/** A paragraph, and whether it came from a heading. */
export type TextBlock = { text: string; heading: boolean };

/** Whitespace runs into single spaces, the desktop's `normalise`. */
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

/** True when any child element closes a paragraph of its own. */
function hasBlockChild(element: Element): boolean {
  for (const child of element.children) {
    if (BLOCK.has(child.tagName.toLowerCase())) return true;
  }
  return false;
}

/**
 * The reading order of a document's prose.
 *
 * A block element that holds no block of its own is one paragraph; one that
 * does is a container, and its own text — the runs between its children — is
 * emitted where it appears. That is what keeps a `<div><p>a</p><p>b</p></div>`
 * from reading as `a b` in one paragraph, and a `<div>a<p>b</p></div>` from
 * losing the `a`.
 */
export function textBlocks(root: Element): TextBlock[] {
  const out: TextBlock[] = [];
  let loose = "";

  const flush = () => {
    const text = normalise(loose);
    loose = "";
    if (text.length > 0) out.push({ text, heading: false });
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      loose += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (SKIPPED.has(tag)) return;

    if (!BLOCK.has(tag)) {
      // Inline: its text belongs to the paragraph being accumulated.
      for (const child of element.childNodes) visit(child);
      return;
    }

    // A block closes whatever run was open before it.
    flush();
    if (!hasBlockChild(element)) {
      const text = normalise(element.textContent ?? "");
      if (text.length > 0) out.push({ text, heading: HEADING.test(tag) });
      return;
    }
    for (const child of element.childNodes) visit(child);
    flush();
  };

  for (const child of root.childNodes) visit(child);
  flush();
  return out;
}

/** One chapter: the blocks collapsed, with the first heading as the title. */
export function chapterFromBlocks(
  blocks: readonly TextBlock[],
  fallbackTitle: string,
): { title: string; paragraphs: string[] } {
  let title: string | null = null;
  const paragraphs: string[] = [];
  for (const block of blocks) {
    // A heading also contributes a paragraph, so it reads as part of the page —
    // the same choice the desktop makes.
    if (block.heading && title === null) title = block.text;
    paragraphs.push(block.text);
  }
  return { title: title ?? fallbackTitle, paragraphs };
}

/** Characters of prose, the number the shelf shows and sorts by. */
export const countChars = (paragraphs: readonly string[]): number =>
  paragraphs.reduce((total, text) => total + text.length, 0);

/**
 * Positioned text runs into lines, dropping the empty ones.
 *
 * This is the PDF's route to the same thing `textBlocks` does for XHTML:
 * pdf.js hands over runs with coordinates rather than paragraphs, so the runs
 * that share a baseline are one line and the document's own end-of-line markers
 * say where a line stops. Both are used — a file that marks nothing still
 * breaks where the baseline moves.
 */
export function pdfLines(items: readonly unknown[]): string[] {
  const lines: string[] = [];
  let current = "";
  let baseline: number | null = null;
  const flush = () => {
    const text = current.trim();
    current = "";
    if (text.length > 0) lines.push(text);
  };
  for (const raw of items) {
    const item = raw as { str?: string; hasEOL?: boolean; transform?: number[]; height?: number };
    // Marked content (a link boundary, a layer switch) carries no text.
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5] ?? null;
    const height = item.height ?? 0;
    if (baseline !== null && y !== null && height > 0 && Math.abs(y - baseline) > height / 2) {
      flush();
    }
    current += item.str;
    if (item.hasEOL) flush();
    baseline = y ?? baseline;
  }
  flush();
  return lines;
}
