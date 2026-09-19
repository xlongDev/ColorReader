import { describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render } from "@testing-library/react";

import { useBookHandoff, type CoverBox } from "@/stores/book-handoff";
import { useLandingBox } from "./useLandingBox";

/**
 * What a flight is aimed at, and for how long the aim may change.
 *
 * Both halves are load-bearing. Taking the box once was aimed at where a tile
 * *used to* be for anything that settles after the shelf mounts — a book in the
 * last rows arrived off its tile and the handoff snapped it on, reported as the
 * flight "running down and then up". Re-reading it *during* the flight restarts
 * the transition's clock on every frame, which is the cover chasing a scrolled
 * tile up out of the shelf. The line between the two is `launched`.
 */
function Probe({ visible }: { visible?: (box: Omit<CoverBox, "radius">) => boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLandingBox("b1", ref, "shelf", visible);
  return <div ref={ref} data-probe />;
}

/** A `getBoundingClientRect` that reports whatever the frame asks for. */
function rects(container: HTMLElement, top: (frame: number) => number) {
  let frame = 0;
  const element = container.querySelector("[data-probe]") as HTMLElement;
  element.getBoundingClientRect = () => {
    const y = top(frame);
    frame += 1;
    return {
      x: 40,
      y,
      width: 138,
      height: 184,
      left: 40,
      top: y,
      right: 178,
      bottom: y + 184,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

/** A flight is in the air, leaving the reader, so the shelf tile is the pad. */
function flightInTheAir(land: (id: string, to: CoverBox) => void) {
  useBookHandoff.setState({
    id: "b1",
    coverUrl: null,
    from: null,
    to: null,
    side: "reader",
    launched: false,
    land,
  });
}

/** The y of the last box reported. */
function lastAim(land: { mock: { calls: [string, CoverBox][] } }) {
  return land.mock.calls.at(-1)?.[1].y;
}

describe("useLandingBox", () => {
  it("keeps the aim on the destination until the flight leaves, then goes quiet", async () => {
    const land = vi.fn<(id: string, to: CoverBox) => void>();
    flightInTheAir(land);
    const { container } = render(<Probe />);
    // The rows are still settling — the library's data has just landed, say —
    // and then the shelf holds still.
    const settling = [100, 120, 140, 160, 160];
    rects(container, (frame) => settling[Math.min(frame, settling.length - 1)] ?? 160);

    await vi.waitFor(() => expect(lastAim(land)).toBe(160));
    const callsBeforeLaunch = land.mock.calls.length;

    // The flight leaves: from here on the aim is fixed, whatever the shelf does.
    useBookHandoff.getState().markLaunched();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(land.mock.calls.length).toBe(callsBeforeLaunch);
  });

  it("does not repeat a box that has not moved", async () => {
    const land = vi.fn<(id: string, to: CoverBox) => void>();
    flightInTheAir(land);
    const { container } = render(<Probe />);
    rects(container, () => 160);

    // Each report restarts the frame the launcher is waiting on to leave, so a
    // box that is merely still has to go unreported.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(land).toHaveBeenCalledTimes(1);
  });

  it("does not chase sub-pixel settling", async () => {
    const land = vi.fn<(id: string, to: CoverBox) => void>();
    flightInTheAir(land);
    const { container } = render(<Probe />);
    // Fractions of a pixel are a page settling, not a destination moving — and
    // treating them as movement would keep restarting the launcher's frame, so
    // the cover would never leave.
    const breathing = [100.2, 100.4, 100.6];
    rects(container, (frame) => breathing[Math.min(frame, breathing.length - 1)] ?? 100.6);

    // 100.2 and 100.4 are the same whole pixel; 100.6 is the next one. Two
    // reports, and then nothing.
    await vi.waitFor(() => expect(land).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(land).toHaveBeenCalledTimes(2);
  });

  it("stays off a pad the caller refuses", async () => {
    const land = vi.fn<(id: string, to: CoverBox) => void>();
    flightInTheAir(land);
    const { container } = render(<Probe visible={() => false} />);
    rects(container, () => 100);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(land).not.toHaveBeenCalled();
  });

  it("reads the destination without waiting for a frame", async () => {
    const land = vi.fn<(id: string, to: CoverBox) => void>();
    flightInTheAir(land);
    // No frames at all, which is the shape of the problem rather than an
    // exaggeration of it: the launcher stops waiting for a destination after
    // `DISSOLVE_AFTER` (200ms) and a runner that hands out five frames a second
    // takes 200ms to hand out one — so a first reading scheduled on a frame
    // arrives *after* the flight has left, aimed at the dissolve box instead of
    // the tile, and the cover lifts and fades where it should have flown home.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    try {
      render(<Probe />);
      await vi.waitFor(() => expect(land).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
