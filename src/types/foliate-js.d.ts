// foliate-js ships plain ES modules with no type declarations. Only the
// surface ColorReader actually touches is declared here; everything else
// stays `unknown` so a foliate upgrade cannot silently type-check against a
// shape we invented. The wildcard module names match the vendored copy at
// `src/vendor/foliate-js/` (the readest fork).

/** One entry of the book's own table of contents. */
type FoliateTocItem = {
  label?: string;
  href?: string;
  subitems?: FoliateTocItem[];
};

/** A document foliate can render: sections, TOC, metadata, resources. */
type FoliateBookDoc = {
  toc?: FoliateTocItem[];
  metadata?: Record<string, unknown>;
  sections?: unknown[];
  rendition?: { layout?: string; viewport?: Record<string, number> };
  dir?: string;
};

/** Rects of one painted run, in the section document's own coordinates. */
type FoliateOverlayerRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** Ink function: turns a run's rects into SVG. */
type FoliateOverlayerDraw = (
  rects: FoliateOverlayerRect[],
  options?: Record<string, unknown>,
) => SVGElement;

/** A painted-run overlay, one per loaded section. */
type FoliateOverlayer = {
  add(
    key: string,
    range: Range,
    draw: FoliateOverlayerDraw,
    options?: Record<string, unknown>,
  ): void;
  remove(key: string): void;
};

/** Payload of the `relocate` event: where the reader is right now. */
type FoliateRelocateDetail = {
  cfi?: string;
  fraction?: number;
  index?: number;
  tocItem?: FoliateTocItem;
  pageItem?: FoliateTocItem;
  /** Section page counter (paginated only; null in scrolled flow). */
  page?: { current: number; total: number } | null;
  range?: unknown;
};

declare module "foliate-js/view.js" {
  export type FoliateRelocate = FoliateRelocateDetail;

  export class View extends HTMLElement {
    book: FoliateBookDoc;
    /** The live `foliate-paginator` (or `foliate-fxl` for fixed layout). */
    renderer: FoliateRenderer | null;
    open(book: FoliateBookDoc): Promise<void>;
    /** `lastLocation` is a CFI string captured from `relocate`. */
    init(options?: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
    goTo(target: string | number): Promise<void>;
    goToFraction(fraction: number): Promise<void>;
    next(distance?: number): Promise<void>;
    prev(distance?: number): Promise<void>;
    goLeft(): Promise<void>;
    goRight(): Promise<void>;
    getCFI(index: number, range: Range): string;
    /** Resolves a CFI into `{ index, anchor }`; `anchor(doc)` yields a Range. */
    resolveNavigation(target: string | number): { index: number; anchor: unknown };
    /** Draws (or with `remove`, erases) one overlayer annotation. `value` is a
     *  CFI; the caller paints it from the `draw-annotation` event. */
    addAnnotation(annotation: { value: string }, remove?: boolean): Promise<void>;
    deleteAnnotation(annotation: { value: string }): Promise<void>;
    /** `value.startsWith('foliate-search:')` marks a transient search highlight. */
    clearSearch(): void;
    /**
     * Yields `{ index, label, subitems }` per section, `{ cfi, cfis, excerpt }`
     * per match, a `{ progress }` tick between sections, and the string `done`
     * last. `excerpt` is `{ pre, match, post }`.
     */
    search(options: { query: string; index?: number }): AsyncGenerator<unknown>;
    close(): void;
  }

  /**
   * The renderer element foliate puts under the view. Layout attributes are
   * declared on it (`flow`, `max-column-count`, `margin`, `gap`, `animated`)
   * and each assignment re-renders in place.
   */
  export class FoliateRenderer extends HTMLElement {
    setAttribute(qualifiedName: string, value: string): void;
    removeAttribute(qualifiedName: string): void;
    prevSection(): Promise<void>;
    nextSection(): Promise<void>;
    /** True at the first/last page of the current section, with a neighbour
     *  section — used for explicit cross-chapter keyboard paging. */
    isAtSectionEdge(dir: 1 | -1): boolean;
    /** Currently-loaded section documents, used to backfill key forwarders
     *  right after `open()`; absent on `foliate-fxl`. */
    getContents(): { index: number; doc: Document; overlayer?: FoliateOverlayer }[];
    /** Continuous-scroll surface reads for the auto-scroll loop. */
    readonly scrolled: boolean;
    /** Scroll offset of the paginator's scrollport (get/set). */
    containerPosition: number;
    /** Sub-pixel scroll remainder, carried as a composited transform so slow
     *  auto-scroll keeps moving between whole-pixel steps. */
    subpixelOffset: number;
    /** True parked on the very end of the book. */
    readonly atEnd: boolean;
    /** Index of the section filling the viewport; drives TTS and selection. */
    readonly primaryIndex: number;
    /** Brings an anchor (Range or element) into view. */
    scrollToAnchor(anchor: unknown, select?: boolean, smooth?: boolean): Promise<void>;
    /** Injects a stylesheet into every section document (absent on fxl). */
    setStyles?(styles: string): void;
  }

  /** Sniffs the container and returns a `FoliateBook` (EPUB, MOBI/AZW3, …). */
  export function makeBook(file: File | string): Promise<FoliateBookDoc>;
}

declare module "foliate-js/overlayer.js" {
  export class Overlayer {
    constructor(doc: Document);
    /** Paints (or repaints) one run under `key`; `range` is section-local. */
    add(
      key: string,
      range: Range,
      draw: FoliateOverlayerDraw,
      options?: Record<string, unknown>,
    ): void;
    remove(key: string): void;
    static highlight: FoliateOverlayerDraw;
    static underline: FoliateOverlayerDraw;
    static squiggly: FoliateOverlayerDraw;
    static outline: FoliateOverlayerDraw;
  }
}

declare module "foliate-js/mobi.js" {
  /** True when `file` is a Palm-database Kindle container. */
  export function isMOBI(file: File | Blob): Promise<boolean>;
  export class MOBI {
    constructor(options?: { unzlib?: (buf: Uint8Array) => Uint8Array });
    open(file: File | Blob): Promise<FoliateBookDoc>;
  }
}
