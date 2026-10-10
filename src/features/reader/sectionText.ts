/**
 * Rewriting a section's text in place — one pipeline, many rewriters.
 *
 * Two reading settings live in the section text rather than in the injected
 * sheet (no CSS maps one character to another): 替换引号 and 简繁转换. Both
 * have to survive a flip in either order, and the paginator gives us no reload
 * to lean on — `#goTo` reuses an already-mounted view for the section it is on
 * and never re-fires `load` (paginator.js:3812), so the old "flip → `goTo(当前
 * CFI)` → sections rebuild" route quietly did nothing inside one section.
 *
 * So the rewrite is in place, and it is *one* pipeline rather than one pass per
 * rewriter: each pass memorises the node's pre-rewrite string, and a second
 * rewriter memorising its own "original" would capture the first one's output
 * (or the other way round), which is how turning one setting off would have
 * wiped the other's work. Here the original is captured once, on the first
 * sighting, and every change replays *all* the layers that are on from it:
 *
 *   original ──▶ (引号替换?) ──▶ (简繁转换?) ──▶ nodeValue
 *
 * Turning a layer off drops it from the list and the rest replay unchanged.
 */

/** A single rewrite pass over one text node's string. */
export type TextLayer = (text: string) => string;

/**
 * Elements whose text is not prose: a `<style>`'s sheet text is a rule, and
 * `<code>` / `<pre>` / `<kbd>` / `<samp>` carry their punctuation as code.
 * Rewriting them corrupts the rule instead of the paragraph.
 */
const TEXT_SKIP = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "KBD", "SAMP", "TEXTAREA"]);

/**
 * Each rewritten node's string as the book published it. Captured on first
 * sighting and never updated, so the pipeline can always be replayed from the
 * source. Entries die with their documents.
 */
const originals = new WeakMap<Node, string>();

/**
 * Replays `layers` over every text node of `doc`. Returns how many nodes
 * ended up with different text than they had.
 *
 * An empty `layers` restores the book's own characters — which is what
 * "every rewrite is off" means, and why there is no separate restore pass.
 */
export function applySectionText(doc: Document, layers: readonly TextLayer[]): number {
  // Nothing on: touch nothing. A section mounts into this state on every
  // book open, and writing a text node's value back unchanged is still a
  // `characterData` mutation — WebKit invalidates layout for it, which is
  // work with no result. Only nodes we have rewritten before need writing.
  const restoreOnly = layers.length === 0;
  let changed = 0;
  for (const node of textNodes(doc)) {
    const current = node.nodeValue;
    if (!current) continue;
    const stored = originals.get(node);
    if (restoreOnly) {
      if (stored === undefined || stored === current) continue;
      node.nodeValue = stored;
      changed += 1;
      continue;
    }
    const source = stored ?? current;
    originals.set(node, source);
    let output = source;
    for (const layer of layers) output = layer(output);
    if (output === current) continue;
    changed += 1;
    node.nodeValue = output;
  }
  return changed;
}

function textNodes(doc: Document): Text[] {
  const walker = doc.createTreeWalker(doc.body ?? doc, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const element = node.parentElement;
      if (!element) return NodeFilter.FILTER_ACCEPT;
      if (TEXT_SKIP.has(element.tagName)) return NodeFilter.FILTER_REJECT;
      // opencc's convention: an element that opts its subtree out of
      // character conversion. Honoured by both rewriters.
      if (element.classList.contains("ignore-opencc")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}
