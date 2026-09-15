import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { alignTail, applyPosition, type TailPad } from "@/features/reader/paging";
import type { LayoutMode } from "@/features/reader/theme";
import { useSettings } from "@/stores/settings";

/** Extra margin on all four sides while in fullscreen immersion. */
export const FULLSCREEN_MARGIN_BONUS = 48;

/** How long the article stays pinned after the last sidebar width change. */
const PIN_RELEASE_MS = 450;

export interface ReaderLayoutInput {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Continuous scroll vs paged single/double spread. */
  paged: boolean;
  layoutMode: LayoutMode;
  marginX: number;
  fullscreen: boolean;
  /** Fraction along the active axis to re-anchor on after any re-flow. */
  fractionRef: RefObject<number>;
  fontSize: number;
  lineHeightIdx: number;
  paraGapIdx: number;
  indent: boolean;
  fontFamily: string;
}

/**
 * Geometry of the reading viewport: its measured size, the column-grid tail
 * spacer, and the two mirrors (layout mode, applied margin) that every
 * scroll-dependent callback reads instead of a stale closure value.
 *
 * Everything here exists to keep the paged column grid honest. A chapter
 * reflows when the typography, the margin or the pane width changes, and each
 * time that happens the viewport has to be re-anchored on a column boundary —
 * otherwise the reader lands between two columns and sees slivers of both.
 *
 * The width is pinned while the sidebar spring animates: a per-frame multicol
 * re-wrap of a whole chapter is what makes that animation janky, and only the
 * reader pays it.
 */
export function useReaderLayout({
  scrollRef,
  paged,
  layoutMode,
  marginX,
  fullscreen,
  fractionRef,
  fontSize,
  lineHeightIdx,
  paraGapIdx,
  indent,
  fontFamily,
}: ReaderLayoutInput) {
  // End-of-chapter column alignment spacer; mirror kept for idempotent measures.
  const [tail, setTail] = useState<TailPad | null>(null);
  const tailRef = useRef<TailPad | null>(null);
  /** Viewport width, drives the column layout of paged modes. */
  const [viewportW, setViewportW] = useState(0);
  /** Viewport height, caps images to one page box in paged modes (see
      globals.css `.paged-prose`; the measured px beats any 100vh estimate). */
  const [viewportH, setViewportH] = useState(0);
  const [pinnedW, setPinnedW] = useState<number | null>(null);
  const pinnedRef = useRef<number | null>(null);
  const pinReleaseRef = useRef<number | null>(null);

  const layoutModeRef = useRef<LayoutMode>(layoutMode);
  const sideMargin = marginX + (fullscreen ? FULLSCREEN_MARGIN_BONUS : 0);
  const marginRef = useRef<number>(sideMargin);

  /** Re-measure the tail spacer and re-anchor on the current fraction. */
  const reanchor = useCallback(
    (el: HTMLDivElement, margin: number) => {
      alignTail(el, layoutModeRef.current, margin, tailRef, setTail);
      applyPosition(el, fractionRef.current, layoutModeRef.current, margin);
    },
    [fractionRef],
  );

  /** Just the tail half of `reanchor`, for callers that position themselves. */
  const measureTail = useCallback((el: HTMLDivElement) => {
    alignTail(el, layoutModeRef.current, marginRef.current, tailRef, setTail);
  }, []);

  // Switching layout mode re-anchors the same reading position on the new axis.
  useEffect(() => {
    layoutModeRef.current = layoutMode;
    const el = scrollRef.current;
    if (layoutMode === "scroll" && tailRef.current !== null) {
      tailRef.current = null;
      setTail(null);
    }
    if (el) applyPosition(el, fractionRef.current, layoutMode, marginRef.current);
  }, [layoutMode, scrollRef, fractionRef]);

  // Keep the margin mirror fresh; margin is not needed for rendering effects.
  useEffect(() => {
    marginRef.current = sideMargin;
  }, [sideMargin]);

  // Any typography or side-margin change re-flows the columns mid-read; the
  // viewport must re-anchor on the new pitch, otherwise it lands between column
  // boundaries and shows sliced-off slivers of the neighbouring pages. The
  // layout fingerprint skips the work when nothing that re-flows changed
  // (deps-array form trips exhaustive-deps: these inputs intentionally trigger
  // without being read inside).
  const reflowKeyRef = useRef("");
  useEffect(() => {
    const key = paged
      ? `${fontSize}|${lineHeightIdx}|${paraGapIdx}|${indent ? 1 : 0}|${fontFamily}|${sideMargin}`
      : "";
    if (key === reflowKeyRef.current) return;
    reflowKeyRef.current = key;
    if (!paged) return;
    const el = scrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => reanchor(el, sideMargin));
    return () => cancelAnimationFrame(frame);
  });

  // Track the viewport width; paged modes lay the chapter out in columns and
  // re-anchor the position whenever the columns re-flow.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      // Sidebar spring: the article is pinned, the pane's per-frame width
      // changes must not re-wrap anything or re-render the page.
      if (pinnedRef.current !== null) return;
      setViewportW(el.clientWidth);
      setViewportH(el.clientHeight);
      if (layoutModeRef.current !== "scroll") {
        requestAnimationFrame(() => reanchor(el, marginRef.current));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef, reanchor]);

  // Pin the article while a sidebar width spring (hide/show or collapse)
  // resizes the pane; subscribing to the store pins before React commits the
  // shell change, so no frame is ever laid out on an intermediate width.
  useEffect(() => {
    const release = () => {
      const el = scrollRef.current;
      pinnedRef.current = null;
      el?.style.removeProperty("overflow-x");
      setPinnedW(null);
      if (!el) return;
      setViewportW(el.clientWidth);
      if (layoutModeRef.current !== "scroll") {
        requestAnimationFrame(() => reanchor(el, marginRef.current));
      }
    };
    const freeze = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (pinnedRef.current === null) {
        const article = el.querySelector("article");
        pinnedRef.current = Math.round(article?.getBoundingClientRect().width || el.clientWidth);
        setPinnedW(pinnedRef.current);
        // A frozen article can be wider than the shrinking pane; the
        // transient horizontal scrollbar would be the only visual artifact.
        el.style.overflowX = "hidden";
      }
      if (pinReleaseRef.current !== null) window.clearTimeout(pinReleaseRef.current);
      pinReleaseRef.current = window.setTimeout(release, PIN_RELEASE_MS);
    };
    const unsubscribe = useSettings.subscribe((s, prev) => {
      if (s.sidebarHidden !== prev.sidebarHidden || s.sidebarCollapsed !== prev.sidebarCollapsed) {
        freeze();
      }
    });
    return () => {
      unsubscribe();
      if (pinReleaseRef.current !== null) window.clearTimeout(pinReleaseRef.current);
    };
  }, [scrollRef, reanchor]);

  return {
    tail,
    tailRef,
    measureTail,
    viewportW,
    viewportH,
    pinnedW,
    layoutModeRef,
    marginRef,
  };
}
