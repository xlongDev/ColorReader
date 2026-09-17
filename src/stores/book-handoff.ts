import { create } from "zustand";

/** A viewport-space box, the space a `fixed` overlay lives in. */
export interface CoverBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The corner radius, in px, of the element this box came from.
   *
   * Carried so the flight can wear the corner of the cover it is leaving. The
   * two ends of the journey do not agree on one — every cover in the app is
   * rounded to its own size (tile 18px, the 续读 card and the header thumbnail
   * each 14px) — so a radius of the flight's own shows up as a second,
   * differently-rounded edge for as long as the cover it is sitting on takes to
   * fade out. Measured at takeoff: the flight was 14px over an 18px tile.
   */
  radius: number;
}

/**
 * The box alone, for a read that happens every frame.
 *
 * `getComputedStyle` in a loop is a style recalculation per frame, and only the
 * origin's corner is ever used — the flight flies with the corner it left with,
 * so the destination contributes its box and nothing else.
 */
export function rectOf(element: Element): Omit<CoverBox, "radius"> {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

/** `getBoundingClientRect` as a plain box, so nothing holds a live DOMRect. */
export function boxOf(element: Element): CoverBox {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    w: rect.width,
    h: rect.height,
    radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
  };
}

interface Handoff {
  /** The cover in flight, if any. */
  id: string | null;
  coverUrl: string | null;
  /**
   * Which end the flight is leaving. The *other* end is the one that registers
   * the landing, so both ends can tell whether they are the pad or the launcher
   * — without it they both track and write a box every frame.
   */
  side: "shelf" | "reader" | null;
  /** Where it left from — the shelf tile the reader clicked. */
  from: CoverBox | null;
  /** Where it should land — registered by the reader's header thumbnail. */
  to: CoverBox | null;
  begin: (payload: {
    id: string;
    coverUrl: string | null;
    from: CoverBox;
    side: "shelf" | "reader";
  }) => void;
  land: (id: string, to: CoverBox) => void;
  end: () => void;
}

/**
 * The cover mid-flight between the shelf and the reader, in either direction.
 *
 * Why a store rather than a shared `layoutId`: `layoutId` moves an element
 * with a transform, which leaves it in the DOM where it was — so an ancestor's
 * `overflow: hidden` still clips it. Both ends of this journey are clipped
 * frames (the tile's rounded cover, the header's thumbnail), and the flying
 * cover would be sliced by whichever it was leaving. A `fixed` overlay lives
 * outside both, so it can travel the whole way unclipped.
 *
 * The two ends are on different routes, so the handoff has to survive the
 * navigation: the shelf's tile opens it, the reader's header registers the
 * landing box, and the flight closes it — and on the way back the reader's
 * thumbnail opens it and the shelf's tile registers the landing, which is the
 * same three moves in the other direction. A box that never arrives is fine:
 * the flight carries the cover on its own and dissolves.
 */
export const useBookHandoff = create<Handoff>((set) => ({
  id: null,
  coverUrl: null,
  from: null,
  to: null,
  side: null,
  begin: ({ id, coverUrl, from, side }) => set({ id, coverUrl, from, side, to: null }),
  land: (id, to) => set((state) => (state.id === id ? { ...state, to } : state)),
  end: () => set((state) => (state.id === null ? state : { id: null, to: null, side: null })),
}));
