import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { speechSources, unitAtOffset } from "@/features/reader/chapterText";
import type { FoliateHandle } from "@/features/reader/FoliateBookView";
import { rsvpTokens } from "@/features/reader/rsvp";
import {
  joinedText,
  paragraphAt,
  paragraphStart,
  type TextRange,
} from "@/features/reader/selection";
import {
  cursorAt,
  pdfWashNeedle,
  speechUnits,
  washSpan,
  type SpeechGranularity,
  type SpeechStatus,
  type SpeechUnit,
  type WashSpan,
} from "@/features/reader/speech";
import { useSpeechVoices, type Tts } from "@/features/reader/tts";
import { defaultVoice, engineOf } from "@/features/reader/voice";

/**
 * Read-aloud: the queue, the wash, and the transport over it.
 *
 * This is the whole of the reader's read-aloud layer except the two things
 * that belong to the reader itself — where the voice starts when the reader
 * taps the button (it is the page's geometry), and what "the chapter ended"
 * means (it is the page's navigation). Both come in as arguments.
 *
 * It does not own the engine binding either, and that is not an oversight:
 * `goTo` stops the voice on every chapter change, so the reader needs `stop`
 * before this layer can be built, while this layer needs the reader's
 * chapter-roll callback, which is built on top of `goTo`. Handing the binding
 * in is what breaks that cycle — the alternative was a callback hidden in a
 * ref, which is one more piece of invisible state in the exact place two
 * stale-closure bugs have already come from.
 *
 * What is left here is the part that has to move together: the queue and the
 * unit the voice is on decide the wash, the wash decides where the page
 * scrolls, and every transport action restarts the queue from the position the
 * voice holds. Split any of those off and the rest has to reach back for it.
 */

/** Speed reading's token list while it is closed: one shared empty array, so a
 *  closed overlay never looks like a new chapter to the run-reset effect. */
const NO_WORDS: string[] = [];

/** What the read-aloud layer cannot work out for itself. */
export interface ReadAloudOptions {
  /** The engine binding. See the note above on why it is passed in. */
  tts: Tts;
  /** Which renderer is on screen: the two paths queue up differently. */
  useFoliate: boolean;
  isPdf: boolean;
  /** Paragraphs of the chapter on screen, wallpaper markers already blanked. */
  paragraphs: string[] | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  foliateRef: RefObject<FoliateHandle | null>;
  /** The saved voice URI; `null` means "whatever the reader's default is". */
  storedVoice: string | null;
  /** Stored speech rate. The engine is kept in step with it, not the reverse. */
  rate: number;
  /** How much text the wash covers. */
  granularity: SpeechGranularity;
  /** Persists a change the player made. */
  updateSettings: (patch: { speechRate?: number; speechVoiceURI?: string }) => void;
  /** The voice rolled off the end of a chapter, on the prose path. */
  onChapterEnd: () => void;
}

export interface ReadAloudControls {
  /** Session state, straight through for the player. */
  status: SpeechStatus;
  /** The unit the voice is on; `null` before the first one starts. */
  unit: number | null;
  error: string | null;
  loading: boolean;
  /** The voice actually used, resolved rather than stored. */
  voiceUri: string | null;
  /** The queue the voice is walking: prose sentences, or the section's blocks. */
  units: readonly SpeechUnit[];
  /** The wash the prose path paints, in the coordinates of its paragraph. */
  span: WashSpan | null;
  /** The same wash as a needle into a PDF page's own text layer. */
  pdfWash: { text: string; from: number; to: number } | null;
  /** The card; the pill opens it. */
  playerOpen: boolean;
  /** The card's own state setter — the footer toggles it without reading it. */
  setPlayerOpen: Dispatch<SetStateAction<boolean>>;
  /** Speed reading, which takes over the reading area while it is on. */
  rsvpOpen: boolean;
  /** The footer's one button: the same button closes the overlay. */
  toggleRsvp: () => void;
  /** The overlay's own way out. */
  closeRsvp: () => void;
  rsvpWords: string[];
  /** Play/pause: the transport's one button. */
  toggle: () => void;
  stop: () => void;
  /** One utterance. */
  step: (dir: 1 | -1) => void;
  /** One paragraph: the neighbouring run of units from a different block. */
  skip: (dir: 1 | -1) => void;
  seek: (index: number) => void;
  /** A rate or a voice the player changed. */
  applySettings: (change: { rate?: number; voice?: string }) => void;
  /** 「朗读此处」: picks the voice up at the character the reader selected. */
  speakFromSelection: (range: TextRange) => void;
  /**
   * Restarts the prose queue at its first unit. The reader's own
   * chapter-advance effect calls it once the new chapter has rendered, which is
   * why it is not private: the voice rolling into the next chapter is
   * navigation's frame to choose, not this layer's.
   */
  playFromStart: () => void;
}

export function useReadAloud({
  tts,
  useFoliate,
  isPdf,
  paragraphs,
  scrollRef,
  foliateRef,
  storedVoice,
  rate: storedRate,
  granularity,
  updateSettings,
  onChapterEnd,
}: ReadAloudOptions): ReadAloudControls {
  // Destructured: each action is a stable `useCallback`, so the effects below
  // never re-fire when speech state changes.
  const {
    status,
    unit,
    boundary,
    error,
    loading,
    play,
    stop,
    pause,
    resume,
    setRate,
    setVoice,
    boundaryAt,
  } = tts;

  // The voice actually used, resolved rather than stored: with nothing saved
  // the answer is the reader's default — Yunjian, which only the Edge service
  // has — and when that service is unreachable it degrades to a voice the
  // platform owns instead of going silent.
  const { voices } = useSpeechVoices();
  const voiceUri = useMemo(
    () => storedVoice ?? defaultVoice(voices, null)?.uri ?? null,
    [storedVoice, voices],
  );

  /** The player card, and speed reading's overlay — the two surfaces this
   *  layer owns. The sleep timer draws inside the card but is armed elsewhere
   *  (`useSleepTimer`): it stops the voice rather than driving it. */
  const [playerOpen, setPlayerOpen] = useState(false);
  const [rsvpOpen, setRsvpOpen] = useState(false);

  // Read-aloud units for the prose path: the chapter split into sentences. The
  // foliate path builds its own from foliate's blocks, whose text lives in
  // another document. The reader's highlight level is not part of the cut (see
  // `speechUnits`), so changing it never recuts the queue under the voice.
  const speechQueue = useMemo(
    () => (useFoliate ? [] : speechUnits(speechSources(paragraphs ?? []))),
    [useFoliate, paragraphs],
  );
  // 「朗读此处」 can start the voice inside a sentence: the first utterance is
  // spoken from the selected character on, so the wash has to begin where the
  // voice does instead of at the sentence's opening character.
  const [speechTrim, setSpeechTrim] = useState<{ unit: number; trim: number } | null>(null);
  // What the wash covers, in the coordinates of the paragraph it sits in: the
  // sentence or the word the voice is on, or the whole paragraph at that level
  // (see `washSpan` for why nothing is washed until the position arrives).
  const span = useMemo<WashSpan | null>(() => {
    if (unit === null) return null;
    const at = speechQueue[unit];
    if (!at) return null;
    const head = speechTrim?.unit === unit ? speechTrim.trim : 0;
    const wash = washSpan(unit, at, boundary, granularity, head, paragraphs?.[at.source]?.length);
    return wash === null ? null : { source: at.source, ...wash };
  }, [unit, speechQueue, boundary, granularity, speechTrim, paragraphs]);
  // The PDF wash: the same span the prose path paints, expressed as a needle
  // inside the spoken text — the page anchors on the sentence (the two
  // extraction pipelines disagree on whitespace) and paints the span within it.
  const pdfWash = useMemo(() => {
    if (!isPdf || unit === null) return null;
    const at = speechQueue[unit];
    if (!at) return null;
    return pdfWashNeedle(span, at, paragraphs?.[at.source], granularity === "paragraph");
  }, [isPdf, unit, speechQueue, span, paragraphs, granularity]);
  // foliate units, exactly as foliate handed them out, so the follow effect can
  // resolve a unit index back to a block and a range inside the section. State
  // rather than a ref: the player renders their text as it comes in.
  const [foliateUnits, setFoliateUnits] = useState<SpeechUnit[]>([]);

  // Both settings live in refs inside the engine, which is what lets the player
  // hand them over inside its own click and restart immediately (see
  // `applySettings`). These keep the engine in step with anything that changes
  // them another way — a resolved default voice, a stored rate read at launch —
  // without restarting a session nobody is listening to.
  useEffect(() => {
    setRate(storedRate);
  }, [storedRate, setRate]);

  useEffect(() => {
    setVoice(voiceUri);
  }, [voiceUri, setVoice]);

  /** The foliate wash for a unit: the word the engine last reported, in the
   *  block's own coordinates. `null` while the engine has not said where the
   *  voice is — the page still follows the voice, but nothing is washed, so a
   *  sentence never flashes before its word lands. */
  const foliateWashSpan = useCallback(
    (index: number, block: SpeechUnit) => washSpan(index, block, boundary, granularity),
    [granularity, boundary],
  );

  // Follow the voice: `nearest` only scrolls when the paragraph is fully out
  // of view, so skimming ahead is never yanked back.
  useEffect(() => {
    if (!useFoliate) {
      if (unit === null) return;
      const source = speechQueue[unit]?.source;
      if (source === undefined) return;
      scrollRef.current
        ?.querySelector(`[data-para-idx="${source}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    // foliate: the read-aloud units are the section's own text blocks, and the
    // paginator both scrolls to one and washes it, so the line being read is
    // always visible. `null` means the voice stopped — drop the wash. A
    // word-level wash is not this effect's to paint: it lands with the
    // engine's first position report, below.
    const handle = foliateRef.current;
    if (unit === null) {
      handle?.clearTts();
      return;
    }
    const at = foliateUnits[unit];
    if (!at || !handle) return;
    if (granularity === "word") {
      // The word washed a moment ago belongs to the sentence before this one.
      handle.clearTts();
      handle.focusUnit(at, null);
      return;
    }
    // The unit is one sentence at every level; the paragraph level asks for the
    // whole block it sits in, whose extent only foliate knows.
    handle.focusUnit(at, granularity === "paragraph" ? "block" : { start: at.start, end: at.end });
  }, [useFoliate, unit, speechQueue, foliateUnits, granularity, scrollRef, foliateRef]);

  // Word-level narrowing: several of these land inside one sentence, so they
  // only re-wash the run — scrolling again for every word would jitter.
  useEffect(() => {
    if (!useFoliate || granularity !== "word") return;
    if (unit === null || boundary?.unit !== unit) return;
    const at = foliateUnits[unit];
    if (!at) return;
    const wash = foliateWashSpan(unit, at);
    if (wash) foliateRef.current?.paintSpan(at, wash);
  }, [useFoliate, granularity, unit, boundary, foliateUnits, foliateWashSpan, foliateRef]);

  /**
   * Read-aloud for foliate books: one section at a time. foliate owns the
   * scrollport and the block list, so a finished section hands the voice to
   * the next one — there is no continuous chapter to walk like in prose.
   *
   * `fromSelection` starts at the sentence the reader picked instead of at the
   * first block on screen. `onFinish` is passed in rather than closed over so
   * the transport can reuse the section roll-over without capturing a stale
   * section.
   */
  const readFoliateOnwards = useCallback(
    (onFinish: () => void, fromSelection = false) => {
      const handle = foliateRef.current;
      if (!handle) return;
      const reading = fromSelection ? handle.readFromSelection() : handle.readFrom();
      void reading.then((units) => {
        // Empty means the book ran out; `stop` leaves the voice where it ended.
        if (units.length === 0 || handle.bookEnd()) {
          stop();
          return;
        }
        setFoliateUnits(units);
        play(
          units.map((at) => at.text),
          0,
          onFinish,
        );
      });
    },
    [play, stop, foliateRef],
  );

  /** The foliate roll-over: finish this section, hand the voice to the next.
   *  Named as a function expression so it can hand itself to `readFoliateOnwards`
   *  as the continuation while still being memoised: the restart below hangs
   *  off its identity, and a fresh one per render would rebuild that every
   *  time the voice moves. */
  const continueFoliate = useCallback(
    function roll() {
      const handle = foliateRef.current;
      if (!handle || handle.bookEnd()) {
        stop();
        return;
      }
      handle.section(1);
      readFoliateOnwards(roll);
    },
    [readFoliateOnwards, stop, foliateRef],
  );

  /** The queue the voice is walking: prose units, or the foliate section's. */
  const activeUnits = useFoliate ? foliateUnits : speechQueue;

  /**
   * The words speed reading flashes, cut once per run rather than per frame.
   *
   * Only cut while the overlay is open — the token list for a long chapter is
   * not something to hold for every reader who never opens it — and off the
   * same units read-aloud uses, so the two agree about what a chapter says.
   */
  const rsvpWords = useMemo(
    () => (rsvpOpen ? rsvpTokens(activeUnits.map((at) => at.text).join(" ")) : NO_WORDS),
    [rsvpOpen, activeUnits],
  );

  /**
   * Opens speed reading.
   *
   * A foliate book has no chapter-wide text on this side of the IPC — its
   * words live in section documents — so the units are asked of the reader
   * that has them, which hands back the section on screen. Starting where the
   * reader is looking is the right answer anyway: nobody opens speed reading
   * to go back to the top of the chapter.
   */
  const openRsvp = useCallback(() => {
    if (useFoliate) {
      void foliateRef.current?.readFrom().then((units) => {
        if (units.length > 0) setFoliateUnits(units);
      });
    }
    setRsvpOpen(true);
  }, [useFoliate, foliateRef]);

  /** The overlay's own way out, and the footer button when it is already on. */
  const closeRsvp = () => setRsvpOpen(false);

  const toggleRsvp = () => {
    if (rsvpOpen) {
      closeRsvp();
      return;
    }
    openRsvp();
  };

  /** Set when a rate or a voice changed while the voice was on hold: the
   *  utterance being held was spoken with the old settings, so the transport
   *  restarts it instead of playing it out. */
  const restartOnResume = useRef(false);

  /**
   * Restarts the voice where it is, under settings the engine has not applied.
   *
   * Both engines commit the clip they are speaking, so a new rate or voice can
   * only reach the reader on a fresh utterance; restarting at the position the
   * voice has got to — not at the top of the sentence — is what makes the
   * change land now rather than at the next sentence. Picking a held voice up
   * again runs through here too, which is why a paused status is not a refusal.
   *
   * The highlight level needs none of this: it decides how much text the wash
   * covers, and the queue the voice walks is always cut per sentence.
   */
  const restartSpeech = useCallback(() => {
    if (status === "idle" || unit === null || !activeUnits[unit]) return;
    const head = speechTrim?.unit === unit ? speechTrim.trim : 0;
    const spot = boundaryAt();
    const trim = head + (spot !== null && spot.unit === unit ? spot.charIndex : 0);
    setSpeechTrim(trim > 0 ? { unit, trim } : null);
    play(
      activeUnits.map((at) => at.text),
      unit,
      useFoliate ? continueFoliate : onChapterEnd,
      trim,
    );
  }, [
    status,
    unit,
    speechTrim,
    activeUnits,
    boundaryAt,
    play,
    useFoliate,
    onChapterEnd,
    continueFoliate,
  ]);

  /**
   * The player's two settings that only a fresh utterance can carry: both
   * engines commit the clip they are speaking. The change is handed to the
   * engine first — it reads both out of refs, so the restart already speaks at
   * the new rate and in the new voice — and the reading then carries on from
   * where the voice was.
   */
  const applySettings = (change: { rate?: number; voice?: string }) => {
    if (change.rate !== undefined) {
      updateSettings({ speechRate: change.rate });
      setRate(change.rate);
    }
    if (change.voice !== undefined) {
      updateSettings({ speechVoiceURI: change.voice });
      // Crossing engines cannot hand a queue over: `useTts` ends the session
      // rather than carrying on in a voice the reader just replaced.
      const crossed = engineOf(voiceUri) !== engineOf(change.voice);
      setVoice(change.voice);
      if (crossed) return;
    }
    // A voice that is on hold is restarted by the transport instead: the reader
    // gets the new setting when they pick the reading up again.
    if (status === "paused") {
      restartOnResume.current = true;
      return;
    }
    restartSpeech();
  };

  /** Jumps the voice to a unit — a transport step, or the scrubber. */
  const seek = (index: number) => {
    if (activeUnits.length === 0) return;
    const at = Math.max(0, Math.min(index, activeUnits.length - 1));
    // A transport jump always lands on an utterance boundary, so any head
    // trim left over from 「朗读此处」 no longer applies.
    setSpeechTrim(null);
    play(
      activeUnits.map((utterance) => utterance.text),
      at,
      useFoliate ? continueFoliate : onChapterEnd,
    );
  };

  /** One utterance. */
  const step = (dir: 1 | -1) => {
    if (unit === null) return;
    seek(unit + dir);
  };

  /** One paragraph: the neighbouring run of units from a different block. */
  const skip = (dir: 1 | -1) => {
    if (unit === null || activeUnits.length === 0) return;
    const source = activeUnits[unit]?.source;
    if (dir === 1) {
      const next = activeUnits.findIndex((at, index) => index > unit && at.source !== source);
      if (next >= 0) seek(next);
      return;
    }
    // Rewind to this block's own first unit, then to the start of the one
    // before it — the usual "previous track" behaviour.
    let head = unit;
    while (head > 0 && activeUnits[head - 1]!.source === source) head -= 1;
    if (head === 0) return;
    const previous = activeUnits[head - 1]!.source;
    let target = head - 1;
    while (target > 0 && activeUnits[target - 1]!.source === previous) target -= 1;
    seek(target);
  };

  /**
   * Where the voice starts when the reader taps read-aloud: the paragraph on
   * screen, not the top of the chapter. A scrolled pane and a page column both
   * put the visible paragraph inside the scrollport's box, so one hit test
   * covers either layout. A PDF has no paragraph elements — its chapter *is*
   * the page on screen, so starting at zero is already the right page.
   */
  const unitAtView = (): number => {
    const el = scrollRef.current;
    const blocks = paragraphs ?? [];
    const pane = el?.getBoundingClientRect();
    if (!el || !pane) return 0;
    for (const node of el.querySelectorAll<HTMLElement>("[data-para-idx]")) {
      const box = node.getBoundingClientRect();
      if (
        box.bottom > pane.top + 4 &&
        box.top < pane.bottom &&
        box.right > pane.left &&
        box.left < pane.right
      ) {
        const idx = Number(node.dataset.paraIdx);
        return unitAtOffset(speechQueue, blocks, paragraphStart(blocks, idx));
      }
    }
    return 0;
  };

  const toggle = () => {
    if (status === "playing") {
      pause();
      return;
    }
    if (status === "paused") {
      // A rate or voice changed while on hold: those only reach the voice on a
      // fresh utterance, so pick the reading up again instead of playing the
      // held one out at the settings it was spoken with.
      if (restartOnResume.current) {
        restartOnResume.current = false;
        restartSpeech();
        return;
      }
      resume();
      return;
    }
    if (useFoliate) {
      readFoliateOnwards(continueFoliate);
      return;
    }
    if (speechQueue.length > 0) {
      setSpeechTrim(null);
      play(
        speechQueue.map((at) => at.text),
        unitAtView(),
        onChapterEnd,
      );
    }
  };

  /**
   * 「朗读此处」: the voice picks up at the character the reader selected and
   * reads on from there, rather than restarting the chapter or restarting the
   * sentence the selection sits in.
   */
  const speakFromSelection = (range: TextRange) => {
    if (useFoliate) {
      readFoliateOnwards(continueFoliate, true);
      return;
    }
    const blocks = paragraphs ?? [];
    // A PDF selection is measured against pdf.js's text layer, not the prose
    // we speak; locate the quoted text in the extracted page instead.
    const offset = isPdf ? Math.max(joinedText(blocks).indexOf(range.text), 0) : range.start;
    if (speechQueue.length === 0) return;
    const paragraph = paragraphAt(blocks, offset);
    const { index, trim } = cursorAt(
      speechQueue,
      paragraph,
      offset - paragraphStart(blocks, paragraph),
    );
    if (index < 0) return;
    setSpeechTrim(trim > 0 ? { unit: index, trim } : null);
    play(
      speechQueue.map((at) => at.text),
      index,
      onChapterEnd,
      trim,
    );
  };

  /**
   * The voice rolling into the next chapter: the new chapter's queue, from its
   * first unit. The reader calls this from the effect that applies the pending
   * position, so the voice restarts inside the same frame the body appears —
   * which is why it is not done here, off a signal of its own.
   *
   * The prose queue, not the active one: auto-advance is armed by `onChapterEnd`
   * and `onChapterEnd` is only ever a continuation on the prose path.
   */
  const playFromStart = useCallback(() => {
    play(
      speechQueue.map((at) => at.text),
      0,
      onChapterEnd,
    );
  }, [speechQueue, play, onChapterEnd]);

  return {
    status,
    unit,
    error,
    loading,
    voiceUri,
    units: activeUnits,
    span,
    pdfWash,
    playerOpen,
    setPlayerOpen,
    rsvpOpen,
    toggleRsvp,
    closeRsvp,
    rsvpWords,
    toggle,
    stop,
    step,
    skip,
    seek,
    applySettings,
    speakFromSelection,
    playFromStart,
  };
}
