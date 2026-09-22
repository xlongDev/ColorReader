import { useEffect, useRef } from "react";

/**
 * Standard-mapping buttons that turn a page.
 *
 * A Bluetooth page-turner is a handful of switches wearing a gamepad's HID
 * descriptor, so what arrives is a `Gamepad` whose buttons are the pedal —
 * usually the bumpers or the triggers, and the D-pad on the ones that ship a
 * full pad. The four below are the ones every such device actually uses; the
 * face buttons are left alone because a pedal that reports A is indistinguishable
 * from a pad somebody is playing with.
 */
const NEXT_BUTTONS = new Set([5, 7, 15]); // R1, R2, D-pad right
const PREV_BUTTONS = new Set([4, 6, 14]); // L1, L2, D-pad left

/**
 * Turns pages from a gamepad or a Bluetooth page-turner.
 *
 * The Gamepad API has no events: a pad is polled, and `connect`/`disconnect`
 * are the only things the browser announces. So the loop runs only while a pad
 * is attached — a reader with no pedals pays nothing for this, not even a
 * frame — and buttons are edge-detected, because a pedal held down is one
 * press, not a page a frame.
 *
 * Desktop only, by construction rather than by a flag: this is the one place
 * where the app reads input meant for something else. On a phone the same job
 * belongs to the OS (a headset's click, a volume rocker) and intercepting it
 * would mean fighting the platform for events it owns.
 */
export function useGamepadPager({
  enabled,
  onNext,
  onPrev,
}: {
  enabled: boolean;
  onNext: () => void;
  onPrev: () => void;
}) {
  // Handlers mirrored into a ref: they are fresh closures every render, and a
  // dependency on them would tear the poll loop down and rebuild it.
  const handlers = useRef({ onNext, onPrev });
  useEffect(() => {
    handlers.current = { onNext, onPrev };
  }, [onNext, onPrev]);

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;

    const held = new Set<string>();
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      for (const pad of navigator.getGamepads()) {
        if (!pad) continue;
        for (let index = 0; index < pad.buttons.length; index += 1) {
          const key = `${pad.index}:${index}`;
          const down = pad.buttons[index]?.pressed === true;
          if (!down) {
            held.delete(key);
            continue;
          }
          if (held.has(key)) continue;
          held.add(key);
          if (NEXT_BUTTONS.has(index)) handlers.current.onNext();
          else if (PREV_BUTTONS.has(index)) handlers.current.onPrev();
        }
      }
    };

    const start = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      held.clear();
    };

    // A pad already plugged in before the reader opened never fires
    // `gamepadconnected` — the browser only announces the ones that arrive
    // while the page is listening — so the initial state has to be read.
    if (navigator.getGamepads().some(Boolean)) start();
    window.addEventListener("gamepadconnected", start);
    // Two pedals, one unplugged: the other is still a page-turner, so the loop
    // only stops when the last one goes.
    const onDisconnect = () => {
      if (!navigator.getGamepads().some(Boolean)) stop();
    };
    window.addEventListener("gamepaddisconnected", onDisconnect);
    return () => {
      window.removeEventListener("gamepadconnected", start);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
      stop();
    };
  }, [enabled]);
}
