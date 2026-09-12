import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import { Overlayer } from "foliate-js/overlayer.js";
import type { FoliateRelocate, View } from "foliate-js/view.js";
import type { Annotation } from "@/types/ipc";
import type { LayoutMode, PageTransition } from "./theme";
import { speechUnits, unitsFromOffset, TTS_WASH_BOOK } from "./speech";
import type { SpeechUnit, Span } from "./speech";

/** Where the reader is. `cfi` is opaque — hand it back to foliate verbatim. */
export type FoliateLocation = {
  cfi: string;
  /** Progress through the whole book, 0..1, foliate's own section progress. */
  fraction: number;
  /** Label of the covering TOC entry, or "" when the book has no TOC. */
  label: string;
  /** Page within the current section, paginated layouts only. */
  page: { current: number; total: number } | null;
};

/**
 * A completed selection inside a section, ready to become an annotation.
 *
 * `cfi` is foliate's own anchor and the only thing that can re-locate the
 * range: Kindle sections do not line up with the chapter indices our importer
 * extracts, so the (chapter, offset) pair the prose path stores is meaningless
 * here. `section` and the two offsets are still recorded — the section index
 * keeps the annotation list ordered, and the offsets make a row stable enough
 * to delete without resolving the CFI.
 */
export type FoliateSelection = {
  cfi: string;
  text: string;
  /** foliate section index; stored as the annotation's `chapterIdx`. */
  section: number;
  /** In-section UTF-16 offsets, so the list can sort and the pill can delete. */
  startChar: number;
  endChar: number;
  /** Viewport coordinates of the selection box, for the floating pill. */
  x: number;
  y: number;
};

/** One full-text match, with the words around it for the hit list. */
export type FoliateSearchHit = {
  /** Jump target; also the key foliate highlights the match under. */
  cfi: string;
  /** The section's TOC label, empty when the book has none. */
  label: string;
  pre: string;
  match: string;
  post: string;
};

/** One entry of the book's own table of contents, flattened for a list. */
export type FoliateTocEntry = {
  label: string;
  /** The href foliate resolves to a section + anchor; empty means "no link". */
  href: string;
  /** Nesting depth in the book's TOC, 0 at the top level. */
  depth: number;
};

/** Imperative navigation the parent drives from the chrome. */
export type FoliateHandle = {
  /** One page (paginated) or one scroll step, like the flip arrows. */
  flip: (dir: 1 | -1) => void;
  /** One section — the chapter arrows. */
  section: (dir: 1 | -1) => void;
  /** True at the first/last page of the current section, with a neighbour. */
  atEdge: (dir: 1 | -1) => boolean;
  /** Jump to a TOC entry by its index in the flattened list. */
  goToEntry: (index: number) => void;
  /** Advances the scrolled flow by whole `delta` px, `subpixel` carried as a
   *  composited transform; no-op outside the scroll layout. */
  scrollByPx: (delta: number, subpixel: number) => void;
  /** True parked on the very end of the book (auto-scroll stop). */
  bookEnd: () => boolean;
  /** Jumps to a foliate anchor string (a CFI). */
  goToCfi: (cfi: string) => void;
  /** Full-text search across every section; every hit stays highlighted in
   *  the book until `clearSearch`. */
  search: (query: string) => Promise<FoliateSearchHit[]>;
  /** Undoes `search`: drops every match highlight from the sections. */
  clearSearch: () => void;
  /** Read-aloud units of the section on screen, starting at the first block
   *  the reader can actually see. Waits out a pending section change; resolves
   *  empty at the end of the book. */
  readFrom: () => Promise<SpeechUnit[]>;
  /** The same units, but starting at the sentence holding the reader's
   *  selection inside the section. */
  readFromSelection: () => Promise<SpeechUnit[]>;
  /** Brings the unit `readFrom` handed out into view, and washes `span` — the
   *  whole unit, or the word the engine reported. `"block"` washes everything
   *  the unit sits in (the paragraph level) and `null` scrolls without
   *  painting: at word granularity nothing is washed until the voice says
   *  where it is, so the sentence never flashes first. */
  focusUnit: (unit: SpeechUnit, span: Span | null | "block") => void;
  /** Re-washes a narrower run of the unit already in view, without scrolling
   *  — the word-level update that lands several times inside one sentence. */
  paintSpan: (unit: SpeechUnit, span: Span) => void;
  /** Drops the read-aloud wash. */
  clearTts: () => void;
};

/** Typography and palette pushed into the book's own document. */
export type FoliateStyle = {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  /** Paragraph gap in em, mirroring the prose path's per-`p` margin. */
  paraGap: number;
  /** Two-em first-line indent on every paragraph. */
  indent: boolean;
  fg: string;
  bg: string;
  dark: boolean;
};

type Props = {
  bookId: string;
  /** CFI captured from a previous session; ignored when empty. */
  startCfi?: string | null;
  /** Reading layout, mapped onto the foliate renderer's attributes. */
  layout: LayoutMode;
  /** Page turn animation; `slide`/`pan` = native clipped pan, `fade`/`paper` = VT. */
  transition: PageTransition;
  /** Page margins in px, fed to the paginator's margin attributes. */
  marginX: number;
  marginY: number;
  /** Reader typography and palette, injected as a stylesheet. */
  style: FoliateStyle;
  /**
   * Saved highlights. Only the ones carrying a `cfi` can be painted — a
   * Kindle annotation made before CFI support has no anchor foliate can
   * resolve, and is skipped rather than misplaced.
   */
  annotations?: readonly Annotation[];
  /** A completed selection, or `null` when the user cleared it. */
  onSelect?: (selection: FoliateSelection | null) => void;
  /** A click on a painted highlight: `cfi` plus viewport coordinates. */
  onAnnotationClick?: (cfi: string, x: number, y: number) => void;
  onLocationChange?: (location: FoliateLocation) => void;
  /** Called once the book is open, with the flattened table of contents. */
  onTocLoaded?: (entries: FoliateTocEntry[]) => void;
};

/**
 * Our page transitions onto foliate's turn pipeline.
 *
 * **`slide` / `pan`** — foliate's native scroll pan (the default turn in stock
 * foliate). We set `animated` but do NOT set a layered `turn-style`, so the
 * paginator's `#layeredTurn` returns null and the page physically scrolls via
 * `cssAnimateScroll` / `rafAnimateScroll` (transform: translateX on the column
 * strip). This runs inside the renderer div which is `overflow:hidden`-clipped
 * by our reading pane — so the animation never bleeds into the sidebar, exactly
 * matching the EPUB prose path's `scrollTo({behavior:"smooth"})`.
 *
 * **`fade` / `paper`** — the fork's layered View Transition styles
 * (readest#555): the outgoing page is snapshotted and animated over the live
 * incoming one. These paint in the viewport-fixed top layer (escaping ancestor
 * overflow:hidden), so we mark our host with `data-view-transition-root` —
 * foliate's `#vtSetup` scopes the capture naming to that element. Fade stays
 * in place (no overflow); paper curls inward (minor overflow possible but
 * contained by typical reading-pane proportions).
 *
 * **`peel-br` / `peel-tr`** — also layered View Transition styles, but these
 * fold the outgoing page over the diagonal crease joining the opposite corners
 * instead of cross-fading it: `peel-br` grabs the bottom-right corner and folds
 * toward the top-left, `peel-tr` grabs the top-right and folds toward the
 * bottom-left. Pure transform + opacity, so they composite — no mask, no
 * per-frame re-raster. Perspective magnifies the swinging corner, so the
 * paginator clips the transition group to the page box.
 *
 * `animated` is the master switch; without it (`none`) every turn is instant.
 */
const ANIMATED: Record<PageTransition, boolean> = {
  none: false,
  slide: true,
  pan: true,
  fade: true,
  paper: true,
  "peel-br": true,
  "peel-tr": true,
};
const TURN_STYLE: Record<PageTransition, string | null> = {
  none: null,
  slide: null,
  pan: null,
  fade: "fade",
  paper: "curl",
  "peel-br": "peel-br",
  "peel-tr": "peel-tr",
};

/**
 * Maps our layout mode onto the foliate paginator's attributes:
 * scroll = one continuous flow, single = one column, double = a spread.
 * Setting an attribute triggers the paginator's own re-render, and it
 * anchors the current position while reflowing. Page margins ride the same
 * channel (`margin-*` attributes feed the paginator's `--_margin-*` vars).
 */
const applyLayout = (
  view: View,
  layout: LayoutMode,
  transition: PageTransition,
  margin: { x: number; y: number },
) => {
  const renderer = view.renderer;
  if (!renderer) return;
  if (layout === "scroll") {
    renderer.setAttribute("flow", "scrolled");
    renderer.removeAttribute("max-column-count");
    renderer.removeAttribute("animated");
    renderer.removeAttribute("turn-style");
  } else {
    renderer.setAttribute("flow", "paginated");
    renderer.setAttribute("max-column-count", layout === "double" ? "2" : "1");
    // `animated` is the master switch; `slide`/`pan` omit `turn-style` so foliate
    // uses its native scroll pan (clipped to the reading pane). `fade`/`paper` set
    // a layered `turn-style` for VT effects (scoped to data-view-transition-root).
    if (ANIMATED[transition]) {
      renderer.setAttribute("animated", "");
      const turn = TURN_STYLE[transition];
      if (turn) renderer.setAttribute("turn-style", turn);
      else renderer.removeAttribute("turn-style");
    } else {
      renderer.removeAttribute("animated");
      renderer.removeAttribute("turn-style");
    }
  }
  for (const [name, px] of [
    ["margin-left", margin.x],
    ["margin-right", margin.x],
    ["margin-top", margin.y],
    ["margin-bottom", margin.y],
  ] as const) {
    renderer.setAttribute(name, `${px}px`);
  }
};

/**
 * The stylesheet injected into every section document.
 *
 * Typography always. Colour follows the readest scheme and is dark-only:
 * the paginator lifts each section's wallpaper out of the document at load
 * time by reading the computed body background, and falls back to the html
 * background only when body is fully transparent (paginator.js
 * `getBackground`) — so html/body never get a background from us. Instead we
 * publish `--theme-bg-color` on `html`: the paginator's `#background` layer
 * paints it as the page fill for transparent sections, and its resolver swaps
 * the colour component of every section's own background (keeping wallpaper
 * images) for the theme colour. Text is recoloured with the same rules
 * readest ships in `getColorStyles`, minus the element-level repaints we
 * don't expose yet.
 *
 * `color-scheme` must stay untouched anywhere in this chain — neither here
 * nor as a `<meta name="color-scheme">` in index.html: once a frame's used
 * colour scheme resolves away from `normal`, WebKit paints the iframe's
 * transparent-root canvas OPAQUE (dark under `dark`, white otherwise), which
 * sits on top of and completely hides the `#background` layer — the wallpaper
 * vanishes and page fill falls back to the system colour. `--override-color:
 * true` drives the same resolver colour swap without touching the canvas, and
 * the paginator's resolver keeps every image-bearing background (Kindle paper
 * textures) in its original colours, swapping only imageless page fills for
 * the theme colour.
 */
const buildStyleSheet = ({
  fontSize,
  fontFamily,
  lineHeight,
  paraGap,
  indent,
  fg,
  bg,
  dark,
}: FoliateStyle) => {
  const typography = `:root {
  /* The system stack resolves to var(--font-sans) from the app shell,
     which does not exist inside a book iframe — define it here. */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto,
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
html, body {
  /* !important: KF8 books ship their own body typography for print paper;
     the reader settings win over the book. */
  font-size: ${fontSize}px !important;
}
/* A Kindle book restates line-height, font-family, margins and text-indent on
   every paragraph class it ships, so html/body alone never reaches the
   text — measured on a KF8 file: body computed line-height followed the
   setting while every p kept the book's own 1.8. Repeat the settings on the
   text elements themselves. Font SIZE deliberately stays on html/body only:
   the book's em-based sizes scale with it, which keeps its headings and
   title pages at the proportions its designer chose.
   div is included because Calibre/KF8 mobi often wrap body paragraphs in
   div.calibre_2 instead of p — without it the three typography
   settings silently do nothing on those books (see probe on b3.mobi). */
html, body, p, li, blockquote, dd, dt, td, th, div {
  font-family: ${fontFamily} !important;
  line-height: ${lineHeight} !important;
}
/* Both sides of the gap, not just the bottom: these books set a large
   margin-top on their paragraph classes (27–63px measured), which swamped
   a bottom-only override and made 紧凑 and 标准 look identical.
   Paragraph <div>s get the same gap. The :has() guard keeps structural
   container divs (those holding block children) out of the rule so we do
   not inflate spacing around layout boxes; it is kept in its own rule so
   that on a WebView without :has() support only this div clause is dropped,
   not the p/li clause above. */
p, li, blockquote, dd {
  margin-top: ${paraGap}em !important;
  margin-bottom: ${paraGap}em !important;
}
div:not([class*="pagebreak"]):not(:has(> p, > div, > section, > table, > ul, > ol, > blockquote, > h1, > h2, > h3, > h4, > h5, > h6)) {
  margin-top: ${paraGap}em !important;
  margin-bottom: ${paraGap}em !important;
}
/* Off must be as loud as on: the book's own 2em indent survives an omitted
   declaration, so the toggle only reads as broken when it is not forced.
   Same div handling as the gap above. */
p {
  text-indent: ${indent ? "2em" : "0"} !important;
}
div:not([class*="pagebreak"]):not(:has(> p, > div, > section, > table, > ul, > ol, > blockquote, > h1, > h2, > h3, > h4, > h5, > h6)) {
  text-indent: ${indent ? "2em" : "0"} !important;
}`;
  if (!dark) return typography;
  return `${typography}
html {
  --bg-texture-id: none;
  --theme-bg-color: ${bg};
  --theme-fg-color: ${fg};
  --override-color: true;
}
html, body {
  color: ${fg};
}
a:any-link {
  color: lightblue;
}
/* Hardcoded black text the book shipped for white paper. */
font[color="#000000"], font[color="#000"], font[color="black"],
font[color="rgb(0,0,0)"], font[color="rgb(0, 0, 0)"],
*[style*="color: rgb(0,0,0)"], *[style*="color: rgb(0, 0, 0)"],
*[style*="color: #000"], *[style*="color: #000000"], *[style*="color: black"],
*[style*="color:rgb(0,0,0)"], *[style*="color:rgb(0, 0, 0)"],
*[style*="color:#000"], *[style*="color:#000000"], *[style*="color:black"] {
  color: ${fg} !important;
}
/* Callout boxes with inline white/light backgrounds (readest's
   getDarkModeLightBackgroundOverrides). */
*[style*="background-color: #fff"], *[style*="background-color:#fff"],
*[style*="background-color: #ffffff"], *[style*="background-color:#ffffff"],
*[style*="background-color: white"], *[style*="background-color:white"],
*[style*="background: #fff"], *[style*="background:#fff"],
*[style*="background: #ffffff"], *[style*="background:#ffffff"],
*[style*="background: white"], *[style*="background:white"],
*[style*="background-color: rgb(255"], *[style*="background-color:rgb(255"],
*[style*="background: rgb(255"], *[style*="background:rgb(255"] {
  background-color: ${bg} !important;
}`;
};

/**
 * foliate renders every book section in its own blob: iframe. Once the reader
 * clicks into the book text, focus lives inside that iframe, and keydown
 * events dispatched there never bubble to the parent window — so the global
 * pager in ReaderPage (bound on `window`) stops receiving ArrowLeft/Right and
 * Escape. Forward the keys we actually handle from the section document up to
 * the parent window, where the existing handler runs. Editable targets (rare
 * in books, but possible) keep their native behaviour.
 */
const FORWARDED_KEYS = new Set(["ArrowLeft", "ArrowRight", "Escape"]);
const forwardKeyFromSection = (event: KeyboardEvent) => {
  if (!FORWARDED_KEYS.has(event.key)) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  ) {
    return;
  }
  // Stop the iframe from scrolling/acting on the key; the parent window
  // handler performs the page turn. The synthetic event is trusted=false but
  // the handler only reads `key`/`code`/modifiers, so it works regardless.
  event.preventDefault();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      cancelable: true,
      bubbles: true,
    }),
  );
};

/**
 * Payload of foliate's `draw-annotation`: the caller owns the ink, and only
 * it knows which colour a highlight should be.
 */
type DrawAnnotationDetail = {
  draw?: (paint: typeof Overlayer.highlight, options?: Record<string, unknown>) => void;
};

/** Payload of foliate's `show-annotation`: a click on a painted highlight. */
type ShowAnnotationDetail = {
  value?: string;
  range?: Range;
};

/**
 * Block-level elements that carry running text. Read-aloud walks these and
 * takes the innermost ones, so a wrapper `<div>` full of `<p>`s is not read
 * as one giant block after its children.
 */
const BLOCK_SELECTOR =
  "p, li, blockquote, dd, dt, figcaption, pre, h1, h2, h3, h4, h5, h6, td, th, div";

/** Overlayer key of the transient read-aloud wash (one unit at a time). */
const TTS_KEY = "colorreader-tts";

/**
 * Read-aloud wash for a palette, pre-divided so foliate's inside-iframe
 * multiply lands on the same `--accent-soft` the prose path paints. See
 * `TTS_WASH_BOOK` — one wash, both paths.
 */
const ttsWash = (dark: boolean) => (dark ? TTS_WASH_BOOK.dark : TTS_WASH_BOOK.light);

/** One text node of a block, with its offset inside the block's raw text. */
type TextNodeAt = { node: Text; start: number };

/** A block of running text, addressable by character offsets. */
type TextBlock = { text: string; nodes: TextNodeAt[] };

/**
 * Read-aloud blocks of one section document: the innermost text blocks, in
 * document order, each with its text nodes so any character range in
 * `spokenBlocks`' own coordinate space maps back to a DOM `Range`.
 *
 * `getSentences` from foliate's TTS module would segment by sentence, but it
 * builds its ranges with the *host* `document`, and handing it nodes from a
 * blob: iframe is a cross-document Range write — fine in some engines,
 * `WrongDocumentError` in others. Walking block elements keeps every range in
 * the section's own document.
 */
const readBlocks = (doc: Document): TextBlock[] => {
  const root = doc.body ?? doc.documentElement;
  const leaves = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(
    (el) => el.querySelector(BLOCK_SELECTOR) === null,
  );
  const out: TextBlock[] = [];
  for (const el of leaves) {
    const block = blockOf(el);
    if (block) out.push(block);
  }
  if (out.length === 0) {
    // Books that put running text straight into <body> with no block elements.
    const block = blockOf(root);
    if (block) out.push(block);
  }
  return out;
};

/** `el`'s raw text plus the text nodes it is made of, or `null` when empty. */
const blockOf = (el: Element): TextBlock | null => {
  const doc = el.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: TextNodeAt[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    nodes.push({ node: textNode, start: text.length });
    text += textNode.data;
  }
  if (text.trim() === "") return null;
  return { text, nodes };
};

/**
 * A `Range` over `[start, end)` of a block's raw text. Offsets past the last
 * node (or between two of them) clamp to the nearest position, so a unit whose
 * trailing whitespace was collapsed still resolves.
 */
const rangeIn = (block: TextBlock, start: number, end: number): Range | null => {
  const first = block.nodes[0];
  if (!first) return null;
  const doc = first.node.ownerDocument;
  const point = (offset: number) => {
    for (const { node, start: at } of block.nodes) {
      if (offset < at + node.data.length) return { node, offset: offset - at };
    }
    const last = block.nodes[block.nodes.length - 1]!;
    return { node: last.node, offset: last.node.data.length };
  };
  const from = point(Math.min(start, block.text.length));
  const to = point(Math.min(end, block.text.length));
  const range = doc.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
};

/** Index of the first block the reader can see in `host` — the block "read
 *  from here" starts at. Falls back to the top of the section. */
const firstVisibleBlock = (blocks: readonly TextBlock[], host: HTMLElement | null): number => {
  if (!host) return 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const range = rangeIn(block, 0, Math.min(1, block.text.length));
    if (range && rangeInHostView(host, range)) return i;
  }
  return 0;
};

/**
 * Utterance units of a section, dropped up to `block`/`offset` — the reader's
 * own position, in the section's block coordinates. When the position falls
 * inside a sentence the first utterance is trimmed to it, so 「朗读此处」 on
 * three selected words starts with those words. Keeping the block indices
 * intact (rather than renumbering) is what lets `focusUnit` map a unit back to
 * the block it came from.
 */
const unitsFrom = (blocks: readonly TextBlock[], block: number, offset: number): SpeechUnit[] =>
  unitsFromOffset(
    speechUnits(blocks.map((entry, index) => ({ index, text: entry.text }))),
    block,
    offset,
  );

/**
 * Viewport coordinates of a box measured inside a section iframe, translated
 * to the host window — the floating pill is `position: fixed` in that space.
 */
const toHostPoint = (owner: Document | null, rect: { left: number; top: number }) => {
  const frame = owner?.defaultView?.frameElement?.getBoundingClientRect();
  return { x: rect.left + (frame?.left ?? 0), y: rect.top + (frame?.top ?? 0) };
};

/**
 * True when a range inside a section falls inside the view's own box.
 *
 * Both axes have to be tested, not just the vertical one. The two flows move
 * different things: `scrolled` grows each section iframe to its full content
 * height and scrolls the host, `paginated` translates a column strip inside a
 * fixed iframe. Under pagination every column shares the same vertical band —
 * a paragraph on page 40 has the same `top` as one on page 1 — so a
 * vertical-only test passes for the whole section and "read from here" lands
 * on the first paragraph of the chapter. The horizontal half is what tells the
 * columns apart, and the host's box is still the one space both flows agree
 * on.
 */
const rangeInHostView = (host: HTMLElement, range: Range): boolean => {
  const box = range.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return false;
  const owner = range.startContainer.ownerDocument;
  const frame = owner?.defaultView?.frameElement?.getBoundingClientRect();
  const left = box.left + (frame?.left ?? 0);
  const top = box.top + (frame?.top ?? 0);
  const hostBox = host.getBoundingClientRect();
  return (
    top + box.height > hostBox.top + 2 &&
    top < hostBox.bottom - 2 &&
    left + box.width > hostBox.left + 2 &&
    left < hostBox.right - 2
  );
};

/** A node of the book's nested TOC (structurally foliate's own shape). */
type TocNode = { label?: string; href?: string; subitems?: TocNode[] };

/** Flattens foliate's nested TOC into a depth-tagged list. */
const flattenToc = (toc: TocNode[] | undefined): FoliateTocEntry[] => {
  const out: FoliateTocEntry[] = [];
  const walk = (items: TocNode[], depth: number) => {
    for (const item of items) {
      out.push({ label: item.label?.trim() ?? "", href: item.href ?? "", depth });
      if (item.subitems?.length) walk(item.subitems, depth + 1);
    }
  };
  walk(toc ?? [], 0);
  return out.filter((entry) => entry.label !== "");
};

/**
 * Kindle-format reader powered by foliate-js.
 *
 * MOBI/AZW3 (KF6/KF7/KF8) are the one family our plain-paragraph pipeline
 * cannot render faithfully: the page's own stylesheet paints wallpapers,
 * part-title plates and drop caps that a text extract throws away. foliate
 * reassembles each KF8 skeleton with its fragments and hands the browser the
 * original XHTML + CSS, which is what readest does — so the book looks like
 * its designer made it, not like our extraction.
 *
 * The element is created once per book and driven imperatively: foliate owns
 * paging, scrolling, selection and its own history stack.
 */
const FoliateBookView = forwardRef<FoliateHandle, Props>(function FoliateBookView(
  {
    bookId,
    startCfi,
    layout,
    transition,
    marginX,
    marginY,
    style,
    annotations,
    onSelect,
    onAnnotationClick,
    onLocationChange,
    onTocLoaded,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Highlight ink. A fixed translucent wash rather than the app's `--accent`
  // token: the overlay lives inside the book's iframe, which has none of the
  // app's custom properties, and the wash has to survive both paper colours.
  const highlightColor = style.dark ? "rgba(250, 219, 109, 0.26)" : "rgba(255, 209, 46, 0.36)";
  const highlightRef = useRef(highlightColor);
  // Read-aloud wash. The prose path draws the same one with a `<mark>`, so a
  // reader switching a book's format sees one marker, not two styles.
  // Mirrored into a ref for `focusUnit`, which is created once and cannot
  // capture a changing value.
  const ttsRef = useRef<Overlayer | null>(null);
  const ttsColorRef = useRef(ttsWash(style.dark));
  // The listener lives for the lifetime of the element, so it reads the
  // latest callback through a ref instead of re-opening the book on every
  // parent render.
  const report = useRef(onLocationChange);
  useEffect(() => {
    report.current = onLocationChange;
  }, [onLocationChange]);
  // Same for the two selection-facing callbacks.
  const selectReport = useRef(onSelect);
  const clickReport = useRef(onAnnotationClick);
  useEffect(() => {
    selectReport.current = onSelect;
    clickReport.current = onAnnotationClick;
  }, [onSelect, onAnnotationClick]);
  // Read through a ref inside the open effect: layout and style changes are
  // applied by the dedicated effects below, and reopening the book on a
  // settings switch would lose the reading position.
  const layoutRef = useRef(layout);
  const styleRef = useRef(style);
  const transitionRef = useRef(transition);
  const marginsRef = useRef({ x: marginX, y: marginY });
  const tocRef = useRef<FoliateTocEntry[]>([]);
  // Same reason as `report`: the TOC is announced from inside the open
  // effect, which must not re-run because a parent handed us a new closure.
  const tocReport = useRef(onTocLoaded);
  useEffect(() => {
    tocReport.current = onTocLoaded;
  }, [onTocLoaded]);
  // Highlights and read-aloud units, read by the section handlers below.
  const annotationsRef = useRef<readonly Annotation[]>(annotations ?? []);
  const paintedRef = useRef<Set<string>>(new Set());
  const blocksRef = useRef<TextBlock[]>([]);
  // Where the last selection started, parked for 「朗读此处」: the pill clears
  // the browser's own selection the instant it is tapped.
  const spotAnchor = useRef<{ node: Node; offset: number } | null>(null);

  /**
   * Paints every CFI-bearing highlight and unpaints the ones that are gone.
   *
   * foliate resolves each CFI to a section and hands the range back through
   * the `draw-annotation` event; sections that are not loaded simply resolve
   * to nothing, so this is safe to call for the whole list at once and is
   * repeated whenever a section mounts.
   */
  const syncAnnotations = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = new Set(
      annotationsRef.current.flatMap((annotation) => (annotation.cfi ? [annotation.cfi] : [])),
    );
    for (const cfi of paintedRef.current) {
      if (!next.has(cfi)) void view.deleteAnnotation({ value: cfi });
    }
    for (const cfi of next) void view.addAnnotation({ value: cfi });
    paintedRef.current = next;
  }, []);

  /** Turns a section's DOM selection into a CFI-anchored `FoliateSelection`. */
  const captureSelection = useCallback((doc: Document) => {
    const view = viewRef.current;
    const renderer = view?.renderer;
    const selection = doc.getSelection();
    if (!view || !renderer || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      spotAnchor.current = null;
      selectReport.current?.(null);
      return;
    }
    const range = selection.getRangeAt(0);
    spotAnchor.current = { node: range.startContainer, offset: range.startOffset };
    const owner = range.startContainer.ownerDocument ?? doc;
    const index = renderer.getContents().find((entry) => entry.doc === owner)?.index;
    const text = range.toString();
    if (index === undefined || text.trim() === "") {
      selectReport.current?.(null);
      return;
    }
    // In-section character offsets: the length of the text running from the
    // top of the body to the selection start. They order the annotation list
    // and give the pill something to delete, without needing the CFI.
    const head = owner.createRange();
    head.selectNodeContents(owner.body ?? owner.documentElement);
    head.setEnd(range.startContainer, range.startOffset);
    const startChar = head.toString().length;
    const box = range.getBoundingClientRect();
    const point = toHostPoint(owner, box);
    selectReport.current?.({
      cfi: view.getCFI(index, range),
      text: text.trim(),
      section: index,
      startChar,
      endChar: startChar + text.length,
      x: point.x + box.width / 2,
      y: point.y,
    });
  }, []);

  // The three view events that carry annotations: paint requests, clicks on a
  // painted highlight, and a freshly mounted section (whose overlayer is new,
  // so every highlight in it has to be drawn again).
  const onDrawAnnotation = useCallback((event: Event) => {
    const detail = (event as CustomEvent<DrawAnnotationDetail>).detail;
    detail?.draw?.(Overlayer.highlight, { color: highlightRef.current });
  }, []);

  const onShowAnnotation = useCallback((event: Event) => {
    const detail = (event as CustomEvent<ShowAnnotationDetail>).detail;
    const cfi = detail?.value;
    if (!cfi) return;
    const owner = detail.range?.startContainer.ownerDocument ?? null;
    const rect = detail.range?.getBoundingClientRect();
    const point = toHostPoint(owner, rect ?? { left: 0, top: 0 });
    clickReport.current?.(cfi, point.x, point.y);
  }, []);

  // A section's overlayer is created with the section, so every highlight
  // inside it has to be drawn again when it mounts.
  const onOverlay = useCallback(() => {
    syncAnnotations();
  }, [syncAnnotations]);

  /**
   * `load` listener on the paginator: every section document arrives here, and
   * we hook the two things the parent window cannot see — paging keys and
   * selections made inside the book's iframe.
   */
  const attachSection = useCallback(
    (event: Event) => {
      const doc = (event as CustomEvent<{ doc?: Document }>).detail?.doc;
      if (!doc) return;
      doc.addEventListener("keydown", forwardKeyFromSection, true);
      doc.addEventListener("mouseup", () => captureSelection(doc), true);
    },
    [captureSelection],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let view: View | null = null;

    const onRelocate = (event: Event) => {
      const detail = (event as CustomEvent<FoliateRelocate>).detail;
      report.current?.({
        cfi: detail.cfi ?? "",
        fraction: detail.fraction ?? 0,
        label: detail.tocItem?.label ?? "",
        page: detail.page ?? null,
      });
    };

    void (async () => {
      try {
        const bytes = await ipc.bookFile(bookId);
        if (cancelled) return;
        // foliate only needs a File-like: it reads PDB records by range.
        const file = new File([bytes], `${bookId}.mobi`, {
          type: "application/x-mobipocket-ebook",
        });
        // Resolved by the `foliate-js` Vite alias to the vendored readest fork
        // (src/vendor/foliate-js); TS sees the ambient declaration in
        // src/types/foliate-js.d.ts.
        const { makeBook } = await import("foliate-js/view.js");
        const book = await makeBook(file);
        if (cancelled) return;
        view = document.createElement("foliate-view") as View;
        // Custom elements default to `display: inline`, which collapses the
        // paginator's size chain; the host box must be the viewport.
        view.style.cssText = "display:block;width:100%;height:100%";
        view.addEventListener("relocate", onRelocate);
        // Registered before `open` so the very first section's overlayer is
        // covered; `addAnnotation` emits `draw-annotation` synchronously.
        view.addEventListener("draw-annotation", onDrawAnnotation);
        view.addEventListener("show-annotation", onShowAnnotation);
        view.addEventListener("create-overlay", onOverlay);
        host.append(view);
        await view.open(book);
        await view.init(startCfi ? { lastLocation: startCfi } : {});
        viewRef.current = view;
        // The renderer (and its section iframes) exist only after `open()`.
        // Binding the `load` listener before `open` was a silent no-op —
        // `view.renderer` was still null, so nothing ever attached and
        // keyboard paging died whenever focus sat inside the book's iframe
        // (e.g. right after a TOC jump). Bind it now and backfill onto every
        // section doc `open` already loaded, so the first page is covered.
        const renderer = view.renderer;
        if (renderer) {
          renderer.addEventListener("load", attachSection);
          for (const { doc } of renderer.getContents()) {
            if (!doc) continue;
            doc.addEventListener("keydown", forwardKeyFromSection, true);
            doc.addEventListener("mouseup", () => captureSelection(doc), true);
          }
        }
        if (cancelled) return;
        applyLayout(view, layoutRef.current, transitionRef.current, marginsRef.current);
        view.renderer?.setStyles?.(buildStyleSheet(styleRef.current));
        tocRef.current = flattenToc(view.book.toc);
        tocReport.current?.(tocRef.current);
        syncAnnotations();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
      viewRef.current = null;
      paintedRef.current = new Set();
      ttsRef.current = null;
      if (view) {
        view.renderer?.removeEventListener("load", attachSection);
        view.removeEventListener("relocate", onRelocate);
        view.removeEventListener("draw-annotation", onDrawAnnotation);
        view.removeEventListener("show-annotation", onShowAnnotation);
        view.removeEventListener("create-overlay", onOverlay);
        view.close();
        view.remove();
      }
    };
  }, [
    bookId,
    startCfi,
    attachSection,
    captureSelection,
    onDrawAnnotation,
    onShowAnnotation,
    onOverlay,
    syncAnnotations,
  ]);

  // Layout, turn animation and margins apply to the live element: the
  // paginator's attributeChangedCallback re-renders and keeps the anchor.
  useEffect(() => {
    layoutRef.current = layout;
    transitionRef.current = transition;
    marginsRef.current = { x: marginX, y: marginY };
    const view = viewRef.current;
    if (view) applyLayout(view, layout, transition, { x: marginX, y: marginY });
  }, [layout, transition, marginX, marginY]);

  // Typography and palette: injected into the section documents, which the
  // paginator keeps across section changes.
  useEffect(() => {
    styleRef.current = style;
    highlightRef.current = highlightColor;
    ttsColorRef.current = ttsWash(style.dark);
    viewRef.current?.renderer?.setStyles?.(buildStyleSheet(style));
  }, [style, highlightColor]);

  // Highlights: repaint whenever the list changes. foliate draws each one
  // through `draw-annotation`, so a brand-new highlight appears immediately.
  useEffect(() => {
    annotationsRef.current = annotations ?? [];
    syncAnnotations();
  }, [annotations, syncAnnotations]);

  /**
   * Paints the read-aloud wash over one run (a sentence, or a word inside it).
   * The section's overlayer is created with the section, so the previous run is
   * un-painted first — `Overlayer.add` replaces by key, so a word-level update
   * costs one SVG group, not one per word. A section change destroys its
   * overlayer outright, leaving a stale ref the next paint simply drops.
   */
  const paintTts = useCallback((range: Range) => {
    const renderer = viewRef.current?.renderer;
    if (!renderer) return;
    const entry = renderer
      .getContents()
      .find((content) => content.doc === range.startContainer.ownerDocument);
    if (!entry?.overlayer) return;
    if (ttsRef.current && ttsRef.current !== entry.overlayer) ttsRef.current.remove(TTS_KEY);
    ttsRef.current = entry.overlayer;
    entry.overlayer.add(TTS_KEY, range, Overlayer.highlight, {
      color: ttsColorRef.current,
      // Match the prose path's `<mark>` corners, so the wash reads the same
      // whether the page is ours or the book's own.
      radius: 2,
    });
  }, []);

  /** Drops the read-aloud wash (voice stopped, or the book closed). */
  const clearTts = useCallback(() => {
    ttsRef.current?.remove(TTS_KEY);
    ttsRef.current = null;
  }, []);

  /**
   * The text blocks of the section on screen, waiting out a section switch:
   * the paginator renders the next section a frame or two after
   * `nextSection()` resolves, so a chapter roll-over would otherwise fall
   * silent instead of reading on.
   */
  const collectBlocks = useCallback(async (): Promise<TextBlock[]> => {
    const renderer = viewRef.current?.renderer;
    if (!renderer) return [];
    const collect = () => {
      const contents = renderer.getContents();
      const primary =
        contents.find((entry) => entry.index === renderer.primaryIndex) ?? contents[0];
      return primary?.doc ? readBlocks(primary.doc) : [];
    };
    const poll = (attempt: number): Promise<TextBlock[]> => {
      const blocks = collect();
      if (blocks.length > 0) return Promise.resolve(blocks);
      if (attempt >= 15 || (renderer.atEnd && attempt > 0)) return Promise.resolve([]);
      return new Promise((resolve) => window.setTimeout(resolve, 100)).then(() =>
        poll(attempt + 1),
      );
    };
    return poll(0);
  }, []);

  /**
   * Where the reader's selection starts, in the section's own block
   * coordinates: which block, and how far into its raw text.
   *
   * Read from the anchor parked at selection time rather than from the live
   * selection: the pill clears the browser's selection as soon as the reader
   * taps, and collecting the section's blocks is asynchronous — by the time
   * this runs there is nothing left to ask. Blocks are matched by text-node
   * identity, which stays exact even when a whitespace-only block was dropped
   * from the list.
   */
  const selectionSpot = useCallback(
    (blocks: readonly TextBlock[]): { block: number; offset: number } | null => {
      const anchor = spotAnchor.current;
      if (!anchor) return null;
      const node = anchor.node;
      const inner = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      const leaf = inner?.closest(BLOCK_SELECTOR) ?? null;
      const doc = leaf?.ownerDocument;
      if (!leaf || !doc) return null;
      const block = blocks.findIndex(
        (entry) => entry.nodes[0]?.node.parentElement?.closest(BLOCK_SELECTOR) === leaf,
      );
      const first = blocks[block]?.nodes[0];
      if (!first) return null;
      const probe = doc.createRange();
      try {
        probe.setStart(first.node, 0);
        probe.setEnd(node, anchor.offset);
      } catch {
        // A backwards pair means the selection started above this block.
        return null;
      }
      return { block, offset: probe.toString().length };
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      flip: (dir) => {
        const view = viewRef.current;
        if (!view) return;
        void (dir === 1 ? view.next() : view.prev());
      },
      section: (dir) => {
        const renderer = viewRef.current?.renderer;
        if (!renderer) return;
        void (dir === 1 ? renderer.nextSection() : renderer.prevSection());
      },
      atEdge: (dir) => {
        const renderer = viewRef.current?.renderer;
        if (!renderer) return false;
        return renderer.isAtSectionEdge(dir);
      },
      goToEntry: (index) => {
        const view = viewRef.current;
        const href = tocRef.current[index]?.href;
        if (!view || !href) return;
        void view.goTo(href);
      },
      scrollByPx: (delta, subpixel) => {
        const renderer = viewRef.current?.renderer;
        if (!renderer?.scrolled) return;
        renderer.subpixelOffset = subpixel;
        // The browser clamps the scrollport to the content extent, so an
        // overshooting delta parks at the end where `bookEnd` stops the loop.
        renderer.containerPosition += delta;
      },
      bookEnd: () => viewRef.current?.renderer?.atEnd ?? false,
      goToCfi: (cfi) => {
        const view = viewRef.current;
        if (!view || cfi === "") return;
        void view.goTo(cfi);
      },
      search: async (query) => {
        const view = viewRef.current;
        if (!view || query.trim() === "") return [];
        const hits: FoliateSearchHit[] = [];
        for await (const result of view.search({ query })) {
          if (result === "done") break;
          const item = result as {
            cfi?: string;
            label?: string;
            excerpt?: { pre: string; match: string; post: string };
            subitems?: { cfi: string; excerpt?: { pre: string; match: string; post: string } }[];
          };
          if (item.subitems) {
            for (const sub of item.subitems) {
              if (!sub.cfi) continue;
              hits.push({
                cfi: sub.cfi,
                label: item.label ?? "",
                pre: sub.excerpt?.pre ?? "",
                match: sub.excerpt?.match ?? "",
                post: sub.excerpt?.post ?? "",
              });
            }
          } else if (item.cfi) {
            hits.push({
              cfi: item.cfi,
              label: item.label ?? "",
              pre: item.excerpt?.pre ?? "",
              match: item.excerpt?.match ?? "",
              post: item.excerpt?.post ?? "",
            });
          }
        }
        return hits;
      },
      clearSearch: () => {
        viewRef.current?.clearSearch();
      },
      readFrom: async () => {
        const blocks = await collectBlocks();
        if (blocks.length === 0) return [];
        blocksRef.current = blocks;
        // Where the reader is looking, not the top of the section: tapping
        // read-aloud mid-page must not restart the chapter.
        return unitsFrom(blocks, firstVisibleBlock(blocks, hostRef.current), 0);
      },
      readFromSelection: async () => {
        const blocks = await collectBlocks();
        if (blocks.length === 0) return [];
        blocksRef.current = blocks;
        const spot = selectionSpot(blocks);
        return unitsFrom(blocks, spot?.block ?? 0, spot?.offset ?? 0);
      },
      focusUnit: (unit, span) => {
        const renderer = viewRef.current?.renderer;
        const block = blocksRef.current[unit.source];
        if (!renderer || !block) return;
        const whole = span === "block";
        const range = rangeIn(
          block,
          whole ? 0 : (span?.start ?? unit.start),
          whole ? block.text.length : (span?.end ?? unit.end),
        );
        if (!range) return;
        void renderer.scrollToAnchor(range);
        if (span !== null) paintTts(range);
      },
      paintSpan: (unit, span) => {
        const block = blocksRef.current[unit.source];
        if (!block) return;
        const range = rangeIn(block, span.start, span.end);
        if (range) paintTts(range);
      },
      clearTts,
    }),
    [paintTts, clearTts, collectBlocks, selectionSpot],
  );

  if (error) {
    return <p className="text-text-3 p-6 text-sm">这本书的 Kindle 容器打不开：{error}</p>;
  }
  return <div ref={hostRef} className="h-full w-full" data-view-transition-root />;
});

export default FoliateBookView;
