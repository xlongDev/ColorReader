/**
 * Marking a section's pictures that own their line.
 *
 * The paginator sizes a picture to the whole column (`setImageSize`), and a
 * replaced element sits on a baseline: a picture laid out on a line of its own
 * therefore also carries the strut's descent *below* it, which is taller than
 * the page. That residue spills into the next column and, nothing visible
 * having gone with it, the reader renders that column as a blank page
 * (measured on a Calibre cover: three columns for a one-page section, with the
 * last sixteen pixels of the picture split off into the second).
 *
 * Aligning such a picture to the box bottom drops the descent — but doing that
 * to every picture sinks an icon that shares its line with text off the
 * baseline it was authored on (measured: 9px on an 18px icon). Nothing in CSS
 * separates the two: `:only-child` counts elements, so an icon alone between
 * two runs of text matches it just like a cover does. The markup is what
 * separates them, so the sections are walked as they load and the plates are
 * tagged; `foliateStyle.ts` keys the rule off the same attribute.
 */

/** Attribute put on a picture that owns its line. */
export const LONE_FIGURE_ATTR = "data-lone-figure";

/**
 * Siblings that are part of the book's own scaffolding around a plate rather
 * than something sharing its line: a wrapper `<br>`, and the elements of a
 * `<picture>`/`<video>` wrapper. Text is what matters — any non-whitespace
 * text beside the picture means it shares its line.
 */
const SCAFFOLD = new Set(["br", "picture", "video", "canvas", "image", "source", "track"]);

/** True when `parent` holds nothing but `el` and the book's own scaffolding. */
export const isLoneFigure = (el: Element, parent: Element) => {
  for (const node of parent.childNodes) {
    if (node === el) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue?.trim()) return false;
      continue;
    }
    if (node.nodeType === Node.COMMENT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    // `localName` rather than an `instanceof`: a section is another realm.
    if (!SCAFFOLD.has((node as Element).localName)) return false;
  }
  return true;
};

/** Tags the pictures that own their line in a section document. */
export const markLoneFigures = (doc: Document) => {
  for (const el of doc.body.querySelectorAll("img, svg, video, canvas")) {
    const parent = el.parentElement;
    if (parent && isLoneFigure(el, parent)) el.setAttribute(LONE_FIGURE_ATTR, "");
  }
};
