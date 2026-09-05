import { useCallback, useEffect, useRef, useState } from "react";

/** Lifecycle of a read-aloud session. */
export type SpeechStatus = "idle" | "playing" | "paused";

/**
 * Read-aloud over the Web Speech API: one utterance per paragraph keeps the
 * visible progress in step with the voice, and the queue lives inside
 * `speechSynthesis` itself, so `cancel()` tears the whole thing down in one
 * call. A generation counter guards against a platform quirk where a cancelled
 * utterance still fires `onend` — a late event from an abandoned queue must
 * not restart the reader.
 */
export function useTts() {
  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [paragraph, setParagraph] = useState<number | null>(null);
  // Speaks only while `generation` matches: every play/stop bumps it.
  const generation = useRef(0);
  const rate = useRef(1);

  useEffect(() => {
    // Leaving the reader must never leave a voice behind; no state to settle.
    return () => window.speechSynthesis.cancel();
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    window.speechSynthesis.cancel();
    setStatus("idle");
    setParagraph(null);
  }, []);

  /** Reads `paragraphs` from `from`, then calls `onFinish` once the last one
   * ends (the reader uses it to roll into the next chapter). */
  const play = useCallback((paragraphs: string[], from: number, onFinish?: () => void) => {
    generation.current += 1;
    const current = generation.current;
    window.speechSynthesis.cancel();
    setStatus("playing");

    const speak = (index: number) => {
      if (generation.current !== current) return;
      if (index >= paragraphs.length) {
        setStatus("idle");
        setParagraph(null);
        onFinish?.();
        return;
      }
      const text = paragraphs[index];
      setParagraph(index);
      if (text === undefined || text.trim() === "") {
        speak(index + 1);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate.current;
      utterance.addEventListener("end", () => {
        if (generation.current !== current) return;
        speak(index + 1);
      });
      utterance.addEventListener("error", () => {
        if (generation.current !== current) return;
        setStatus("idle");
        setParagraph(null);
      });
      window.speechSynthesis.speak(utterance);
    };
    speak(from);
  }, []);

  /** Applies a new rate; takes effect from the next paragraph on. */
  const setRate = useCallback((value: number) => {
    rate.current = value;
  }, []);

  const pause = useCallback(() => {
    window.speechSynthesis.pause();
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    window.speechSynthesis.resume();
    setStatus("playing");
  }, []);

  return { status, paragraph, play, stop, pause, resume, setRate };
}
