/**
 * Finding a snippet in a section's DOM.
 *
 * A highlight imported from a Kindle clippings file arrives with its text and
 * nothing else, while foliate anchors on a CFI — so the text has to be found in
 * the section it belongs to before it can be painted. The search ignores
 * whitespace and the invisible characters the two sides disagree about, for the
 * same reason the importer does: the clipping and the book are the same
 * sentence, typeset differently.
 *
 * It mirrors `ignorable` in the backend's `library::clippings`. Two copies of
 * twenty lines beat a round trip per page turn.
 */

/** Code units that carry no ink of their own. */
const IGNORABLE = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

function ignorable(unit: number): boolean {
  if (IGNORABLE.has(unit)) return true;
  if (unit === 0x20 || (unit >= 0x09 && unit <= 0x0d) || unit === 0xa0) return true;
  if (unit >= 0x2000 && unit <= 0x200a) return true;
  return (
    unit === 0x2028 || unit === 0x2029 || unit === 0x202f || unit === 0x205f || unit === 0x3000
  );
}

/** Text holders that never carry readable prose. */
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA"]);

/** `String.fromCharCode` argument ceiling, and how much index we hold at once. */
const CHUNK = 4096;

/** A section's text, flattened, with the node every character came from. */
export interface TextIndex {
  /** The text with the ignorable characters dropped. One code unit per entry in
   * `spots`, which is what makes a hit in this string a position in the DOM. */
  flat: string;
  spots: { node: Text; offset: number }[];
}

/** Reduces a needle the way [`indexText`] reduces a section. */
export function condense(text: string): string {
  let out = "";
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (!ignorable(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/**
 * Flattens the readable text under `root`.
 *
 * `flat` is built from code units rather than characters, so a surrogate pair
 * stays two entries and `spots` stays aligned with it — `Range.setStart` wants
 * code-unit offsets, and that is exactly what `spots` carries.
 */
export function indexText(root: Element): TextIndex {
  const spots: TextIndex["spots"] = [];
  const document = root.ownerDocument;
  if (!document) return { flat: "", spots };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let buffer: number[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    const parent = text.parentElement;
    if (parent && SKIP.has(parent.tagName)) continue;
    const data = text.data;
    for (let offset = 0; offset < data.length; offset++) {
      const unit = data.charCodeAt(offset);
      if (ignorable(unit)) continue;
      buffer.push(unit);
      spots.push({ node: text, offset });
      if (buffer.length >= CHUNK) {
        chunks.push(String.fromCharCode(...buffer));
        buffer = [];
      }
    }
  }
  if (buffer.length > 0) chunks.push(String.fromCharCode(...buffer));
  return { flat: chunks.join(""), spots };
}

/** The DOM range `needle` covers, or `null` when the section does not carry it. */
export function findRange(index: TextIndex, needle: string): Range | null {
  const wanted = condense(needle);
  if (wanted === "") return null;
  const at = index.flat.indexOf(wanted);
  if (at === -1) return null;
  const first = index.spots[at];
  const last = index.spots[at + wanted.length - 1];
  if (!first || !last) return null;
  const range = first.node.ownerDocument?.createRange();
  if (!range) return null;
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** One mounted section, as foliate hands them out. */
export type Section = { index?: number; doc?: Document };

/**
 * The mounted section that carries `text`, with the range for it.
 *
 * This is the other half of [`findRange`], for the callers that have one needle
 * and do not know which section holds it — a highlight whose anchor has never
 * been minted. Foliate's section numbering and the importer's chapter numbering
 * do not agree, so guessing a section from a stored chapter index would land on
 * the wrong one; trying what is mounted, and letting the caller check the answer
 * against the text, is the honest way round.
 *
 * The index is built per section until something hits, which is fine for a
 * single needle. Callers searching many needles should hold one [`TextIndex`]
 * per section instead.
 */
export function findInSections(
  sections: readonly Section[],
  text: string,
): { index: number; range: Range } | null {
  for (const { index, doc } of sections) {
    if (index === undefined || !doc) continue;
    const body = doc.body ?? doc.documentElement;
    if (!body) continue;
    const range = findRange(indexText(body), text);
    if (range) return { index, range };
  }
  return null;
}
