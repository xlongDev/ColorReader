/**
 * Edge TTS: the network engine, and the reason `Yunjian` can be the default.
 *
 * Two halves live here, deliberately apart from `tts.ts` — which stays the one
 * place the reader's controls talk to, and the only module that knows there is
 * more than one engine at all:
 *
 * * the **catalogue** is a cache over a single IPC call, so the picker and the
 *   default-voice resolution see the same list without either owning the fetch;
 * * the **engine** is a small scheduler that keeps one clip in flight and the
 *   next two decoded, because the service answers per utterance and something
 *   has to be ready when the current one ends.
 *
 * Playback is Web Audio rather than an `<audio>` element, which is what readest
 * does and what the timing needs: a `BufferSourceNode` can be started at an
 * exact point and its elapsed time read off the context's own clock, whereas a
 * media element would need `timeupdate` — four events a second, visibly chunky
 * against a word-level highlight. It also sidesteps a media element's autoplay
 * policy, since the first network round trip necessarily happens *after* the
 * click that started it.
 */

import { useEffect, useSyncExternalStore } from "react";

import { ipc } from "@/lib/ipc";

import { wordCues, type WordCue } from "./speech";
import { edgeVoiceId, edgeVoices, type Voice } from "./voice";
import type { SpeechBoundary, SpeechStatus } from "./tts";

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

interface Catalogue {
  voices: Voice[];
  /** Set when the service could not be reached; the picker shows it. */
  error: string | null;
  loading: boolean;
}

let catalogue: Catalogue = { voices: [], error: null, loading: false };
const listeners = new Set<() => void>();
/** One attempt per session, unless something explicitly asks again. */
let attempted = false;

function publish(next: Partial<Catalogue>): void {
  catalogue = { ...catalogue, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): Catalogue => catalogue;

/** Fetches the catalogue. Safe to call from anywhere: a second caller while one
 *  is in flight is a no-op, which is what lets both the picker and the reader
 *  ask for it without coordinating. */
export function loadEdgeVoices(): void {
  if (attempted) return;
  attempted = true;
  publish({ loading: true });
  void ipc
    .ttsEdgeVoices()
    .then((list) => publish({ voices: edgeVoices(list), error: null, loading: false }))
    .catch((error: unknown) => publish({ error: messageOf(error), loading: false }));
}

/** Tries again after a failure. Starting the app offline must not mean reading
 *  in a system voice until the next launch. */
export function reloadEdgeVoices(): void {
  attempted = false;
  loadEdgeVoices();
}

/** The service's voices, and whether they are reachable. */
export function useEdgeVoices(): Catalogue {
  useEffect(() => {
    loadEdgeVoices();
  }, []);
  return useSyncExternalStore(subscribe, snapshot);
}

/** IPC rejections are `AppError` strings, not `Error`s. */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Edge 语音不可用，请检查网络";
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                 */
/* -------------------------------------------------------------------------- */

/** Where the voice is inside one utterance. */
interface Ready {
  buffer: AudioBuffer;
  cues: WordCue[];
}

/** How far ahead to synthesise. Two clips is roughly ten seconds of speech:
 *  enough to ride out a slow request, far short of holding a chapter in memory. */
const AHEAD = 2;

/** What the engine reports as the voice moves. */
export interface EdgeEvents {
  status: (status: SpeechStatus) => void;
  unit: (index: number) => void;
  boundary: (boundary: SpeechBoundary | null) => void;
  /** The queue ran out; the reader rolls into the next chapter. */
  done: () => void;
  /** The service could not be reached. */
  fail: (message: string) => void;
}

export interface PlayOptions {
  /** Characters to cut off the head of the first utterance, so 「朗读此处」
   *  starts on the selected character rather than the top of its sentence. */
  trim?: number;
  voice: string;
  rate: number;
  onFinish?: () => void;
}

export interface EdgeEngine {
  play: (units: readonly string[], from: number, options: PlayOptions) => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  setRate: (rate: number) => void;
  setVoice: (uri: string | null) => void;
  setTrackBoundary: (on: boolean) => void;
}

/** `atob` yields one character per byte; the loop is the whole decoder. */
function bytesOf(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes.buffer;
}

/**
 * Waits for a context to actually be live before a source is scheduled.
 *
 * A stop leaves the context suspended to save power, and `resume()` is
 * asynchronous — scheduling a source against a suspend that has not landed yet
 * produces silence with no error, so the wait is not optional.
 */
async function live(ctx: AudioContext): Promise<void> {
  if (ctx.state !== "running") await ctx.resume();
}

/**
 * The scheduler behind one reader.
 *
 * Everything asynchronous is guarded by a generation counter: a stop, a seek or
 * a chapter roll-over invalidates whatever was already in flight, and a late
 * response must never restart a queue nobody is listening to.
 */
export function createEdgeEngine(events: EdgeEvents): EdgeEngine {
  let context: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let frame = 0;
  let generation = 0;
  /** Bumped whenever the voice or the rate changes, so clips synthesised under
   *  the old settings are discarded instead of played back wrong. */
  let settings = 0;

  let texts: readonly string[] = [];
  let origin = 0;
  let trim = 0;
  let voice = "";
  let rate = 1;
  let trackBoundary = false;
  let onFinish: (() => void) | undefined;

  const ready = new Map<number, Ready>();
  const inflight = new Map<number, Promise<void>>();
  let startedAt = 0;

  /** Built on first play, which is inside the reader's own click: a context
   *  created outside a gesture starts suspended and would play nothing. */
  function audio(): AudioContext {
    context ??= new AudioContext();
    return context;
  }

  function stop(): void {
    generation += 1;
    cancelAnimationFrame(frame);
    if (source) {
      // The `ended` listener is left attached: the counter was already bumped,
      // so it is inert, and the node is unreachable once it is dropped here.
      try {
        source.stop();
      } catch {
        // Never started; nothing to stop.
      }
      source.disconnect();
      source = null;
    }
    ready.clear();
    inflight.clear();
    texts = [];
    onFinish = undefined;
    if (context?.state === "running") void context.suspend();
  }

  async function synthesize(index: number, current: number): Promise<void> {
    const base = texts[index];
    if (base === undefined) return;
    const text = index === origin && trim > 0 ? base.slice(trim) : base;
    if (text.trim() === "") return;
    const mine = settings;
    try {
      const clip = await ipc.ttsEdgeSpeak(text, voice, rate);
      if (generation !== current || mine !== settings) return;
      const buffer = await audio().decodeAudioData(bytesOf(clip.audio));
      if (generation !== current || mine !== settings) return;
      ready.set(index, { buffer, cues: wordCues(text, clip.words) });
    } catch (error) {
      if (generation !== current) return;
      events.fail(messageOf(error));
      stop();
    }
  }

  async function ensure(index: number, current: number): Promise<Ready | null> {
    if (index >= texts.length) return null;
    const cached = ready.get(index);
    if (cached) return cached;
    const running = inflight.get(index);
    if (running) {
      await running;
      return ready.get(index) ?? null;
    }
    // Registered before the first suspension point, so a parallel caller for
    // the same index joins this one instead of starting a second request.
    const task = synthesize(index, current);
    inflight.set(index, task);
    await task;
    // Only if the entry is still ours: a settings change may have replaced it.
    if (inflight.get(index) === task) inflight.delete(index);
    return ready.get(index) ?? null;
  }

  /** Keeps the next `AHEAD` clips warm, following the playhead rather than the
   *  queue's start, so a long chapter never stops to wait. */
  function warm(from: number, current: number): void {
    for (let index = from + 1; index <= from + AHEAD; index += 1) void ensure(index, current);
  }

  /** Tracks the cue list against the context's clock, reporting only when the
   *  word actually changes — a reader must not re-render sixty times a second
   *  to redraw the same highlight. */
  function follow(index: number, cues: readonly WordCue[], current: number): void {
    cancelAnimationFrame(frame);
    if (!trackBoundary || cues.length === 0) return;
    let last = -1;
    const step = () => {
      if (generation !== current) return;
      const ctx = context;
      if (!ctx || source === null) return;
      const at = ctx.currentTime - startedAt;
      let hit = -1;
      for (let position = 0; position < cues.length; position += 1) {
        const cue = cues[position];
        if (cue !== undefined && cue.at <= at) hit = position;
        else break;
      }
      if (hit !== last) {
        last = hit;
        const cue = hit < 0 ? undefined : cues[hit];
        events.boundary(
          cue === undefined
            ? null
            : { unit: index, charIndex: cue.start, charLength: cue.end - cue.start },
        );
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function settle(): void {
    events.boundary(null);
    events.status("idle");
    source = null;
    const finish = onFinish;
    onFinish = undefined;
    finish?.();
  }

  async function start(index: number, current: number): Promise<void> {
    const clip = await ensure(index, current);
    if (generation !== current) return;
    if (!clip) {
      settle();
      return;
    }
    const ctx = audio();
    await live(ctx);
    if (generation !== current) return;
    source = ctx.createBufferSource();
    source.buffer = clip.buffer;
    source.connect(ctx.destination);
    source.addEventListener("ended", () => {
      if (generation !== current) return;
      cancelAnimationFrame(frame);
      void start(index + 1, current);
    });
    events.unit(index);
    events.boundary(null);
    startedAt = ctx.currentTime;
    source.start();
    warm(index, current);
    follow(index, clip.cues, current);
  }

  function play(units: readonly string[], from: number, options: PlayOptions): void {
    stop();
    // `stop` bumped the counter; this is the live one until the next stop.
    const current = generation;
    if (from >= units.length) {
      events.status("idle");
      options.onFinish?.();
      return;
    }
    texts = [...units];
    origin = from;
    trim = options.trim ?? 0;
    voice = edgeVoiceId(options.voice);
    rate = options.rate;
    onFinish = options.onFinish;
    events.status("playing");
    void start(from, current);
  }

  function pause(): void {
    if (context === null || context.state !== "running") return;
    void context.suspend();
    events.status("paused");
  }

  function resume(): void {
    void audio().resume();
    events.status("playing");
  }

  /** Settings apply from the next utterance: the clip being spoken was already
   *  synthesised with the old ones, and the platform engine behaves the same
   *  way, so the reader learns one rule for both.
   *
   *  Both caches are dropped, and the in-flight ones with them: a request still
   *  on the wire under the old settings must not be the thing the next
   *  `ensure` waits for, or a rate change would look like the book ending. */
  function reconfigure(): void {
    settings += 1;
    ready.clear();
    inflight.clear();
  }

  return {
    play,
    stop,
    pause,
    resume,
    setRate(value) {
      if (value === rate) return;
      rate = value;
      reconfigure();
    },
    setVoice(uri) {
      if (uri === null) return;
      const id = edgeVoiceId(uri);
      if (id === voice) return;
      voice = id;
      reconfigure();
    },
    setTrackBoundary(value) {
      trackBoundary = value;
    },
  };
}
