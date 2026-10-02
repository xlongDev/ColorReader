import { useState } from "react";

import { cn } from "@/lib/cn";
import { hexToHsv, hsvToHex } from "@/lib/color";

/**
 * A colour, picked where it is being chosen.
 *
 * Deliberately not `<input type="color">`. That hands the choice to the OS, and
 * on both of this app's builds that means a picker that opens *away* from the
 * row being edited: a floating panel pinned to the window's corner in the
 * browser, a native macOS colour window over the app on the desktop. A
 * saturation square and a hue rail are two gradients and a pointer handler, they
 * stay in the sheet, and they behave the same in both builds.
 *
 * Hue lives in state rather than being re-derived from the value, because black
 * and grey have no hue of their own: re-deriving on every change would snap the
 * square back to red the moment the reader dragged the brightness to the bottom.
 * Everything else is read off the value, which is what keeps the square, the
 * rail and the hex field beside them telling the same story.
 *
 * The square takes a pointer, the rail is a real `input[type=range]` and so has
 * the keyboard, and the hex field is the route for anyone using neither — any
 * colour the square can reach, a field can be told. Labelling the square as a
 * slider would promise arrow keys it does not have; it says nothing to assistive
 * tech and hides nothing that is not reachable another way.
 */

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const KNOB =
  "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white";

export function ColorPicker({
  value,
  onChange,
  className,
}: {
  /** A concrete `#rrggbb`; callers resolve "no colour of my own" for it. */
  value: string;
  onChange: (hex: string) => void;
  className?: string;
}) {
  const [hue, setHue] = useState(() => hexToHsv(value).h);
  const [seen, setSeen] = useState(value);
  const [dragging, setDragging] = useState(false);
  const { s, v } = hexToHsv(value);

  // Adjust during render, the shell's own pattern for "a prop changed and the
  // local view has to follow": a colour that arrived from somewhere else — a
  // preset swatch, the theme token, a typed hex — moves the knobs, while our own
  // drags leave both alone (`hsvToHex` of our state *is* the value by then).
  if (value !== seen) {
    setSeen(value);
    if (hsvToHex(hue, s, v) !== value) setHue(hexToHsv(value).h);
  }

  const paintSquare = (event: React.PointerEvent<HTMLDivElement>) => {
    // Measured per event, not cached: the sheet scrolls under the finger.
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp01((event.clientX - rect.left) / rect.width);
    const y = clamp01((event.clientY - rect.top) / rect.height);
    onChange(hsvToHex(hue, x, 1 - y));
  };

  const hueHex = hsvToHex(hue, 1, 1);

  return (
    <div className={cn("w-full", className)}>
      <div
        aria-hidden
        data-color-pad
        onPointerDown={(event) => {
          // Capture, so a drag that leaves the square keeps painting: the
          // handlers below are on the element the pointer was captured by.
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          paintSquare(event);
        }}
        onPointerMove={(event) => {
          if (dragging) paintSquare(event);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className="border-hairline relative h-24 w-full cursor-crosshair touch-none rounded-sm border"
        style={{
          backgroundColor: hueHex,
          backgroundImage:
            "linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))",
        }}
      >
        <span
          className={cn(KNOB, "size-3.5")}
          style={{
            left: `${s * 100}%`,
            top: `${(1 - v) * 100}%`,
            backgroundColor: value,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
          }}
        />
      </div>

      <input
        type="range"
        className="range range-hue w-full"
        min={0}
        max={360}
        step={1}
        value={Math.round(hue)}
        aria-label="色相"
        onChange={(event) => {
          const next = Number(event.target.value);
          setHue(next);
          onChange(hsvToHex(next, s, v));
        }}
        style={{ "--range-thumb": hueHex } as React.CSSProperties}
      />
    </div>
  );
}
