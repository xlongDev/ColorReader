import { create } from "zustand";

/** A viewport-space box, the space a `fixed` overlay lives in. */
export interface CoverBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `getBoundingClientRect` as a plain box, so nothing holds a live DOMRect. */
export function boxOf(element: Element): CoverBox {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

interface Handoff {
  /** The cover in flight, if any. */
  id: string | null;
  coverUrl: string | null;
  /** Where it left from — the shelf tile the reader clicked. */
  from: CoverBox | null;
  /** Where it should land — registered by the reader's header thumbnail. */
  to: CoverBox | null;
  begin: (payload: { id: string; coverUrl: string | null; from: CoverBox }) => void;
  land: (id: string, to: CoverBox) => void;
  end: () => void;
}

/**
 * The cover mid-flight from the shelf into the reader.
 *
 * Why a store rather than a shared `layoutId`: `layoutId` moves an element
 * with a transform, which leaves it in the DOM where it was — so an ancestor's
 * `overflow: hidden` still clips it. Both ends of this journey are clipped
 * frames (the tile's rounded cover, the header's thumbnail), and the flying
 * cover would be sliced by whichever it was leaving. A `fixed` overlay lives
 * outside both, so it can travel the whole way unclipped.
 *
 * The two ends are on different routes, so the handoff has to survive the
 * navigation: the shelf opens it, the reader's header registers the landing
 * box, and the flight closes it. Left ungated it would also fire on the way
 * back, dropping a cover onto a tile that may be scrolled out of sight.
 */
export const useBookHandoff = create<Handoff>((set) => ({
  id: null,
  coverUrl: null,
  from: null,
  to: null,
  begin: ({ id, coverUrl, from }) => set({ id, coverUrl, from, to: null }),
  land: (id, to) => set((state) => (state.id === id ? { ...state, to } : state)),
  end: () => set((state) => (state.id === null ? state : { id: null, to: null })),
}));
