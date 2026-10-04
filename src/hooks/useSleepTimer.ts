import { useCallback, useEffect, useRef, useState } from "react";

/** What the sleep timer will do when it fires. */
export type SleepTimer =
  { kind: "minutes"; minutes: number; endsAt: number } | { kind: "chapter" } | null;

/** A sleep-timer choice as the card reports it back. */
export type SleepChoice = "off" | "chapter" | number;

/**
 * The read-aloud sleep timer.
 *
 * Two shapes: stop after N minutes, or stop when the chapter ends. An armed
 * minutes timer is a plain timeout — the card draws the countdown from the same
 * deadline, so nothing here ticks — and a chapter timer is not a timer at all,
 * it is a flag the reader's own chapter-change effect asks about.
 *
 * `onFire` is handed in rather than reached for: this owns *when* to stop, the
 * reader owns *what* stopping means (it is the one holding the voice).
 *
 * The current value is mirrored into a ref because the chapter-change path
 * reads it from inside an effect whose closure may be older than the last arm.
 * That effect is also a dependency of the reader's position effect, and a fresh
 * identity there re-applies the pending scroll — which yanks the page back to
 * the top of the chapter the moment a timer is armed. So both callbacks below
 * are identity-stable, and the value the caller compares is the ref's.
 *
 * `SleepTimer` / `SleepChoice` are declared here rather than beside the card
 * that draws them, which is where they started. The card is only a view of
 * this, and the three modules involved are already in each other's import
 * graph (`TtsHost` -> this hook -> the player -> `TtsHost`); a `import type`
 * is erased so nothing breaks, but declaring them in the component would close
 * that loop for real the first time the player is imported for a value.
 */
export interface SleepTimerControls {
  sleep: SleepTimer;
  /** Arms, re-arms or clears the timer from a chip's value. */
  choose: (choice: SleepChoice) => void;
  /**
   * Called when a chapter ends: clears a chapter-scoped timer, and reports
   * whether one was armed — the caller still has to stop the voice itself, and
   * only it knows that a chapter timer means "stop here" rather than "read on".
   */
  clearIfChapterEnded: () => boolean;
}

export function useSleepTimer(onFire: () => void): SleepTimerControls {
  const [sleep, setSleep] = useState<SleepTimer>(null);
  const sleepRef = useRef<SleepTimer>(null);
  useEffect(() => {
    sleepRef.current = sleep;
  }, [sleep]);

  useEffect(() => {
    if (sleep?.kind !== "minutes") return;
    const id = window.setTimeout(
      () => {
        onFire();
        setSleep(null);
      },
      Math.max(sleep.endsAt - Date.now(), 0),
    );
    return () => window.clearTimeout(id);
  }, [sleep, onFire]);

  const choose = useCallback((choice: SleepChoice) => {
    if (choice === "off") {
      setSleep(null);
      return;
    }
    if (choice === "chapter") {
      setSleep({ kind: "chapter" });
      return;
    }
    setSleep({ kind: "minutes", minutes: choice, endsAt: Date.now() + choice * 60_000 });
  }, []);

  const clearIfChapterEnded = useCallback(() => {
    // The ref, not the state: the caller is an effect whose closure may be
    // older than the last arm.
    if (sleepRef.current?.kind !== "chapter") return false;
    sleepRef.current = null;
    setSleep(null);
    return true;
  }, []);

  return { sleep, choose, clearIfChapterEnded };
}
