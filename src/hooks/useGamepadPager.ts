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
 *
 * The D-pad's **up and down** are not in here, and that is the point of them:
 * a stick has to be pushed and released to say something, and a d-pad does not
 * — so a reader who has one can walk the reading axis with a thumb that never
 * leaves the pad, which is the whole reason for putting the ruler on the same
 * two directions the stick drives. They are read separately, below.
 */
const NEXT_BUTTONS = new Set([5, 7, 15]); // R1, R2, D-pad right
const PREV_BUTTONS = new Set([4, 6, 14]); // L1, L2, D-pad left
/**
 * D-pad up and down: the reading axis, exactly as the stick's other axis.
 *
 * 🔴 **12 is up and 13 is down** in the standard mapping — the d-pad is numbered
 * clockwise from the top, so a table that pairs 12 with "next" reads as
 * "down" and drives the ruler backwards. Getting it backwards is invisible on a
 * stick (which reports axes, not directions) and immediately visible on a d-pad,
 * which is why it lives in a table of its own rather than inside `NEXT_BUTTONS`.
 */
const LINE_NEXT_BUTTONS = new Set([13]); // D-pad down
const LINE_PREV_BUTTONS = new Set([12]); // D-pad up

/**
 * How long a held input waits before it starts repeating, and how often it
 * repeats after that.
 *
 * A reader walking the ruler down a page does not want to press twenty times,
 * and the platform's own key-repeat numbers are the wrong ones here: those are
 * tuned for typing a letter every other frame, and a page turn is a 340ms
 * animated move (see `RULER_STEP_MS`) — repeating faster than the move finishes
 * queues steps the reader did not ask for and lands the band somewhere they
 * never pointed at. So the first repeat waits longer than a key does, and the
 * cadence is slower than a key's, in step with the band rather than with typing.
 */
export const REPEAT_DELAY = 420;
export const REPEAT_INTERVAL = 130;

/** What one frame of a held input means: whether it fires, and its new count. */
export type Repeat = { repeats: number; fire: boolean };

/**
 * One frame of a **held** input: does it fire again, and how many times has it
 * fired in this hold?
 *
 * The first repeat waits `delay` and the rest wait `interval`, which is the
 * shape every platform's key repeat has and the reason the count is handed back:
 * the two cadences cannot be told apart without it. `elapsed` is the time since
 * this hold last fired — zero on the frame it fired.
 *
 * Pure, so the cadence can be stated as one rule and tested as one.
 */
export function heldRepeat(
  repeats: number,
  elapsed: number,
  delay = REPEAT_DELAY,
  interval = REPEAT_INTERVAL,
): Repeat {
  if (elapsed < (repeats === 0 ? delay : interval)) return { repeats, fire: false };
  return { repeats: repeats + 1, fire: true };
}

/**
 * How far a stick has to travel before it counts as pushed.
 *
 * A stick at rest is not reliably 0 — a worn one rests at 0.02, a thumb resting
 * on it 0.15, and the noise floor moves with the pad and the hand. Anything
 * under this reads as centered rather than pushed: without it a pad lying on a
 * desk turns the page by itself. It is also the distance the axis has to come
 * back from before it counts again, which is why it is not tighter — a pad whose
 * axis rests at 0.3 would then never fire at all.
 */
export const STICK_DEADZONE = 0.5;

/**
 * Which way a stick points, or that it is not pushed.
 *
 * `1` is the positive direction (right, or down), `-1` the negative one, `0`
 * centered. The dead zone is what makes a resting stick read as centered; what
 * makes a *held* stick fire once is the caller's latch, because only the caller
 * knows whether that axis has come back to center since.
 */
export function stickDirection(value: number, threshold = STICK_DEADZONE): -1 | 0 | 1 {
  if (value >= threshold) return 1;
  if (value <= -threshold) return -1;
  return 0;
}

/** What one reading of a stick axis means: where it is now, and whether it fires. */
export type StickStep = {
  /** The axis' new latch: the direction that has just fired, or 0 when centered. */
  armed: -1 | 0 | 1;
  /** How many times this push has fired — 0 on the frame it first fires. */
  repeats: number;
  /** The direction to act on, or 0 to do nothing this frame. */
  fire: -1 | 0 | 1;
};

/**
 * One frame of one stick axis: a push fires at once, and holding it over fires
 * again on the repeat cadence.
 *
 * A stick is not a button — it has no edge to detect, only a position that
 * changes continuously — so the latch is what makes a push a press. Without it a
 * stick held over at 1.0 would turn a page a frame, and a reader working their
 * way down a book would never stop. With it a held stick goes quiet and then,
 * after the repeat delay, starts walking — which is the same thing a held arrow
 * key does, and the reason a reader who pushes the stick down expects to be able
 * to keep reading without letting go.
 *
 * Each axis keeps its own latch rather than sharing one: a stick eased from right
 * to up passes through a frame where both axes read pushed, and a shared latch
 * would swallow whichever came second.
 *
 * Pure, so the rule can be stated as one: the latch and the hold count in, the
 * same two and a `fire` out.
 */
export function stickStep(
  armed: -1 | 0 | 1,
  repeats: number,
  value: number,
  elapsed: number,
  threshold = STICK_DEADZONE,
): StickStep {
  const dir = stickDirection(value, threshold);
  // Centered re-arms: the stick is back where it can be pushed again, and
  // whatever it was doing has ended — count and all.
  if (dir === 0) return { armed: 0, repeats: 0, fire: 0 };
  // A fresh push fires at once. Armed only for the direction that fired, so a
  // stick swung from right to up without pausing is a second deliberate push
  // rather than a continuation of the first.
  if (armed !== dir) return { armed: dir, repeats: 0, fire: dir };
  // Held, and already fired: this is where a hold becomes a walk. `elapsed` is
  // the time since it last fired, so the cadence never drifts with the frame.
  const held = heldRepeat(repeats, elapsed);
  return { armed, repeats: held.repeats, fire: held.fire ? dir : 0 };
}

/**
 * Turns pages from a gamepad or a Bluetooth page-turner.
 *
 * The Gamepad API has no events: a pad is polled, and `connect`/`disconnect`
 * are the only things the browser announces. So the loop runs only while a pad
 * is attached — a reader with no pedals pays nothing for this, not even a
 * frame — and buttons are edge-detected, because a pedal held down is one
 * press, not a page a frame.
 *
 * The two sticks are read the same way, on axes 0 (left/right) and 1 (up/down):
 * a push past the dead zone is one step, and the axis has to read centered again
 * before it can fire. **Horizontal drives the page**, through the very same calls
 * the buttons use, so a stick and a pedal cannot disagree about which way the
 * book goes. **Vertical is the reading ruler's**, because up and down is the one
 * direction nothing else in a reader moves in — and it is handed the arrow keys'
 * own step, ruler and all, rather than a page turn of its own.
 *
 * The D-pad's up and down drive that same axis, on the same two calls. A stick
 * has to be pushed and released to say something and a d-pad does not, so for a
 * reader whose pad has one this is the same walk with a thumb that never leaves
 * it — and it is the only way to reach the ruler on a pad with no stick at all.
 *
 * Each axis keeps its own latch rather than one shared: a reader easing the
 * stick from right to up passes through a moment where both axes read pushed,
 * and a shared latch would swallow whichever came second.
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
  onLineForward,
  onLineBack,
}: {
  /** The reader's own switch: off and the pad does nothing here at all. */
  enabled: boolean;
  /** One step of the page — buttons and the horizontal stick both land here. */
  onNext: () => void;
  onPrev: () => void;
  /**
   * Stick pushed **down**. This is the reading direction, not the page's: the
   * caller's job is to step the ruler when it is on and turn the page when it is
   * not, which is exactly what the down arrow does.
   */
  onLineForward?: () => void;
  /** Stick pushed **up**. */
  onLineBack?: () => void;
}) {
  // Handlers mirrored into a ref: they are fresh closures every render, and a
  // dependency on them would tear the poll loop down and rebuild it.
  const handlers = useRef({ onNext, onPrev, onLineForward, onLineBack });
  useEffect(() => {
    handlers.current = { onNext, onPrev, onLineForward, onLineBack };
  }, [onNext, onPrev, onLineForward, onLineBack]);

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;

    /**
     * One frame of one input that is being held down, whoever holds it: the stick
     * axis and the button are the same question asked two ways, and both are
     * answered by "when did this last fire, and how many times has it".
     */
    type Hold = { at: number; repeats: number };
    const held = new Map<string, Hold>();
    /**
     * Which way each axis last fired, and how often — a stick has no buttons to
     * edge-detect on, so this stands in for "pressed". Two axes, two holds, and
     * `axis` hands back the new one rather than writing: a single shared latch
     * would be wrong for a stick swung from one axis to the other without pausing.
     */
    const latch = {
      across: { armed: 0 as -1 | 0 | 1, hold: { at: 0, repeats: 0 } },
      down: { armed: 0 as -1 | 0 | 1, hold: { at: 0, repeats: 0 } },
    };
    let raf = 0;

    const tick = () => {
      const now = performance.now();
      raf = requestAnimationFrame(tick);
      for (const pad of navigator.getGamepads()) {
        if (!pad) continue;
        for (let index = 0; index < pad.buttons.length; index += 1) {
          const key = `${pad.index}:${index}`;
          const pressed = pad.buttons[index]?.pressed === true;
          if (!pressed) {
            held.delete(key);
            continue;
          }
          // A button that is down fires at once, then repeats on the cadence
          // while it stays down — a reader walking the ruler down a page with a
          // thumb parked on the d-pad should not have to press it twenty times.
          const already = held.get(key);
          let repeats = 0;
          if (already) {
            const repeat = heldRepeat(already.repeats, now - already.at);
            if (!repeat.fire) continue;
            repeats = repeat.repeats;
          }
          held.set(key, { at: now, repeats });
          if (NEXT_BUTTONS.has(index)) handlers.current.onNext();
          else if (PREV_BUTTONS.has(index)) handlers.current.onPrev();
          else if (LINE_NEXT_BUTTONS.has(index)) handlers.current.onLineForward?.();
          else if (LINE_PREV_BUTTONS.has(index)) handlers.current.onLineBack?.();
        }
        const call = handlers.current;
        /**
         * One axis, one hold. Same question as the button above — when did this
         * last fire, how many times — so it asks the same function and hands the
         * counts back the same way.
         */
        const axis = (
          value: number | undefined,
          state: { armed: -1 | 0 | 1; hold: Hold },
          fire: (dir: -1 | 1) => void,
        ) => {
          const step = stickStep(state.armed, state.hold.repeats, value ?? 0, now - state.hold.at);
          state.armed = step.armed;
          // 🔴 The clock is re-stamped **only when it fires**, which is what the
          // button above does with its `continue` and what `at` means: when this
          // hold last spoke. Stamping it every frame — the obvious way to write
          // this — holds `elapsed` at one frame forever, so `heldRepeat` never
          // reaches its delay and **a held stick never repeats at all** while the
          // d-pad beside it does. Measured on a real pad: 1.6s of holding gave
          // one step on the stick and eight on the d-pad.
          if (step.fire !== 0) {
            state.hold = { at: now, repeats: step.repeats };
            fire(step.fire);
          }
        };
        // Across is the page: the same two calls the D-pad's left and right get,
        // so a reader who swaps between stick and buttons never gets two answers
        // to one question.
        axis(pad.axes[0], latch.across, (dir) => (dir === 1 ? call.onNext() : call.onPrev()));
        axis(pad.axes[1], latch.down, (dir) =>
          dir === 1 ? call.onLineForward?.() : call.onLineBack?.(),
        );
      }
    };

    const start = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      held.clear();
      // The holds go with it: a pad that was held when the reader switched the
      // feature off, and back on, must not resume mid-repeat.
      latch.across = { armed: 0, hold: { at: 0, repeats: 0 } };
      latch.down = { armed: 0, hold: { at: 0, repeats: 0 } };
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
