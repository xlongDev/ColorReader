import { useEffect, useState } from "react";

import { useMotion } from "@/lib/motion";
import { useBookHandoff, type CoverBox } from "@/stores/book-handoff";

/**
 * The cover carried from the shelf into the reader.
 *
 * A page-level shared element, done as a `fixed` overlay rather than a shared
 * `layoutId`: a layout animation moves its element with a transform and leaves
 * it where it was in the DOM, so the tile's own `overflow: hidden` would slice
 * the cover as it left. This layer sits in the shell, outside every route, so
 * the route cross-fade (which blurs and scales the page it is leaving) does not
 * drag it along either.
 *
 * It renders in the overlay host, so `fixed` means the window.
 */
export function BookCoverFlight() {
  const m = useMotion();
  const id = useBookHandoff((s) => s.id);
  const coverUrl = useBookHandoff((s) => s.coverUrl);
  const from = useBookHandoff((s) => s.from);
  const to = useBookHandoff((s) => s.to);
  const end = useBookHandoff((s) => s.end);

  if (m.reduce || id === null || from === null) return null;

  // A fresh mount per flight, keyed by book: the launcher inside has to start
  // from "not launched" every time, and this component itself stays mounted
  // for the life of the app.
  return <Flight key={id} coverUrl={coverUrl} from={from} to={to} onDone={end} />;
}

function Flight({
  coverUrl,
  from,
  to,
  onDone,
}: {
  coverUrl: string | null;
  from: CoverBox;
  to: CoverBox | null;
  onDone: () => void;
}) {
  // Launch on the frame *after* mount, so the browser has the "at the shelf"
  // transform to transition from instead of snapping straight to the end.
  const [launched, setLaunched] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setLaunched(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Without a landing box the cover still has to leave: a cold route chunk can
  // take longer than the gesture reads as connected, and a book with no cover
  // never registers one. It lifts and dissolves instead of hovering forever.
  const landing: CoverBox = to ?? {
    x: from.x - from.w * 0.08,
    y: from.y - 44,
    w: from.w * 1.16,
    h: from.h * 1.16,
  };

  /**
   * Travel by transform, and by a CSS transition rather than a JS-driven one.
   *
   * Two things this buys, both measured:
   *
   * 1. **No per-frame layout.** The first version animated
   *    `left/top/width/height`, which recalculated style and laid the element
   *    out again on every frame — 35 layouts and 35 style recalcs for a single
   *    flight, each one re-rasterizing the cover at a new size. That is why a
   *    large EPUB cover stuttered where the small PNG pdf.js renders for a PDF
   *    did not.
   * 2. **The compositor owns it.** A JS-driven animation needs the main thread
   *    every frame, and the main thread is exactly what the reader is using to
   *    build its chapter at that moment — so the cover froze precisely when the
   *    reader was heaviest. A CSS transition keeps the flight running on the
   *    compositor regardless, and re-targets on its own if the reader
   *    registers its landing box mid-flight.
   */
  return (
    <div
      className="shadow-panel pointer-events-none fixed z-[70] overflow-hidden rounded-sm"
      style={{
        left: from.x,
        top: from.y,
        width: from.w,
        height: from.h,
        // Scaling from the corner makes the offsets plain deltas.
        transformOrigin: "top left",
        willChange: "transform, opacity",
        transform: launched
          ? `translate(${landing.x - from.x}px, ${landing.y - from.y}px) scale(${landing.w / from.w}, ${landing.h / from.h})`
          : "translate(0px, 0px) scale(1, 1)",
        opacity: launched ? 0 : 1,
        // The travel is the transition; the fade only tidies the last third, so
        // the cover is still solid when it arrives at the header.
        transition: `transform var(--dur-flight) var(--ease-out), opacity 200ms var(--ease-out) 240ms`,
      }}
      onTransitionEnd={(event) => {
        if (event.propertyName === "transform") onDone();
      }}
    >
      {coverUrl && (
        <img src={coverUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      )}
    </div>
  );
}
