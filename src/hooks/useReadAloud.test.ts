import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FoliateHandle } from "@/features/reader/FoliateBookView";
import type { SpeechUnit } from "@/features/reader/speech";
import type { Tts } from "@/features/reader/tts";
import { useReadAloud, type ReadAloudOptions } from "@/hooks/useReadAloud";

/**
 * The voice list is the one thing here that reaches outside the hook — it
 * subscribes to `speechSynthesis` and asks the Edge service for a catalogue —
 * so it is replaced rather than exercised. Everything else is the real thing,
 * including `speechUnits` and `washSpan`: a stub queue would make these tests
 * agree with themselves about offsets the page actually paints.
 */
vi.mock("@/features/reader/tts", () => {
  const voices: never[] = [];
  return { useSpeechVoices: () => ({ voices, edgeError: null }) };
});

/** Three units over two paragraphs: 第一句。 第二句。 | 第三句。 */
const PARAGRAPHS = ["第一句。第二句。", "第三句。"];
const QUEUE = ["第一句。", "第二句。", "第三句。"];

function fakeTts(overrides: Partial<Tts> = {}): Tts {
  return {
    status: "idle",
    unit: null,
    boundary: null,
    error: null,
    loading: false,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setRate: vi.fn(),
    setVoice: vi.fn(),
    boundaryAt: vi.fn(() => null),
    ...overrides,
  };
}

/**
 * The foliate side of the bridge. Only the members this layer reaches for are
 * here; a finished section calls back into the reader, so the stub answers with
 * an empty queue unless a case says otherwise.
 */
function fakeHandle(overrides: Partial<Record<string, unknown>> = {}): FoliateHandle {
  return {
    readFrom: vi.fn(() => Promise.resolve([] as SpeechUnit[])),
    readFromSelection: vi.fn(() => Promise.resolve([] as SpeechUnit[])),
    bookEnd: () => false,
    section: vi.fn(),
    clearTts: vi.fn(),
    focusUnit: vi.fn(),
    paintSpan: vi.fn(),
    ...overrides,
  } as unknown as FoliateHandle;
}

function setup(overrides: Partial<ReadAloudOptions> = {}) {
  const tts = overrides.tts ?? fakeTts();
  const options: ReadAloudOptions = {
    tts,
    useFoliate: false,
    isPdf: false,
    paragraphs: PARAGRAPHS,
    scrollRef: { current: null },
    foliateRef: { current: null },
    storedVoice: null,
    rate: 1,
    granularity: "sentence",
    updateSettings: vi.fn(),
    onChapterEnd: vi.fn(),
    ...overrides,
  };
  const view = renderHook((props: ReadAloudOptions) => useReadAloud(props), {
    initialProps: options,
  });
  return { ...view, tts, options };
}

describe("useReadAloud", () => {
  it("starts the chapter from the top when nothing is on screen", () => {
    const { result, tts, options } = setup();

    act(() => result.current.toggle());

    // `unitAtView` answers zero with no scrollport to hit-test, which is the
    // PDF case too: its chapter *is* the page on screen.
    expect(tts.play).toHaveBeenCalledWith(QUEUE, 0, options.onChapterEnd);
  });

  it("hands pause and resume straight to the engine", () => {
    const playing = setup({ tts: fakeTts({ status: "playing", unit: 0 }) });
    act(() => playing.result.current.toggle());
    expect(playing.tts.pause).toHaveBeenCalledTimes(1);
    expect(playing.tts.play).not.toHaveBeenCalled();

    const paused = setup({ tts: fakeTts({ status: "paused", unit: 0 }) });
    act(() => paused.result.current.toggle());
    expect(paused.tts.resume).toHaveBeenCalledTimes(1);
    expect(paused.tts.play).not.toHaveBeenCalled();
  });

  /**
   * Both engines commit the clip they are speaking, so a rate or a voice can
   * only reach the reader on a fresh utterance. While the voice is on hold the
   * restart is deferred to the resume instead — restarting now would speak at
   * the new setting to nobody.
   */
  it("defers a settings change made while the voice is on hold", () => {
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "paused", unit: 1 }),
    });

    act(() => result.current.applySettings({ rate: 1.5 }));

    expect(options.updateSettings).toHaveBeenCalledWith({ speechRate: 1.5 });
    expect(tts.setRate).toHaveBeenCalledWith(1.5);
    expect(tts.play).not.toHaveBeenCalled();

    act(() => result.current.toggle());

    expect(tts.resume).not.toHaveBeenCalled();
    // Restarted, not resumed: from the unit it holds, and with the head trim
    // that keeps it there rather than at the top of the sentence.
    expect(tts.play).toHaveBeenCalledWith(QUEUE, 1, options.onChapterEnd, 0);
  });

  it("restarts the held utterance from the position the engine reported", () => {
    const boundaryAt = vi.fn(() => ({ unit: 1, charIndex: 3, charLength: 2 }));
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "playing", unit: 1, boundaryAt }),
    });

    act(() => result.current.applySettings({ rate: 2 }));

    expect(tts.play).toHaveBeenCalledWith(QUEUE, 1, options.onChapterEnd, 3);
  });

  it("ends the session instead of restarting it when the voice crosses engines", () => {
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "playing", unit: 0 }),
      storedVoice: "edge:zh-CN-YunjianNeural",
    });

    act(() => result.current.applySettings({ voice: "com.apple.voice.zh" }));

    expect(options.updateSettings).toHaveBeenCalledWith({ speechVoiceURI: "com.apple.voice.zh" });
    expect(tts.setVoice).toHaveBeenCalledWith("com.apple.voice.zh");
    // `useTts` already tore the queue down; a restart would speak into a
    // session the reader just replaced.
    expect(tts.play).not.toHaveBeenCalled();
  });

  it("restarts when the new voice stays on the same engine", () => {
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "playing", unit: 0 }),
      storedVoice: "com.apple.voice.a",
    });

    act(() => result.current.applySettings({ voice: "com.apple.voice.b" }));

    expect(tts.play).toHaveBeenCalledWith(QUEUE, 0, options.onChapterEnd, 0);
  });

  it("clamps the scrubber to the queue and drops the head trim", () => {
    const { result, tts, options } = setup({ tts: fakeTts({ status: "playing", unit: 0 }) });

    act(() => result.current.seek(99));
    expect(tts.play).toHaveBeenLastCalledWith(QUEUE, 2, options.onChapterEnd);

    act(() => result.current.seek(-5));
    expect(tts.play).toHaveBeenLastCalledWith(QUEUE, 0, options.onChapterEnd);
  });

  it("steps one utterance at a time", () => {
    const { result, tts, options } = setup({ tts: fakeTts({ status: "playing", unit: 2 }) });

    act(() => result.current.step(-1));
    expect(tts.play).toHaveBeenCalledWith(QUEUE, 1, options.onChapterEnd);

    act(() => result.current.step(1));
    expect(tts.play).toHaveBeenLastCalledWith(QUEUE, 2, options.onChapterEnd);
  });

  it("skips to the next paragraph's first unit, and back to the previous one's", () => {
    const forward = setup({ tts: fakeTts({ status: "playing", unit: 0 }) });
    act(() => forward.result.current.skip(1));
    // Unit 1 is still 第一句's paragraph; 第三句。 is the next block.
    expect(forward.tts.play).toHaveBeenCalledWith(QUEUE, 2, forward.options.onChapterEnd);

    const back = setup({ tts: fakeTts({ status: "playing", unit: 2 }) });
    act(() => back.result.current.skip(-1));
    // Rewinds to this block's own first unit, then to the start of the one
    // before it — the usual "previous track" behaviour.
    expect(back.tts.play).toHaveBeenCalledWith(QUEUE, 0, back.options.onChapterEnd);
  });

  it("has nowhere to skip back to from the first paragraph", () => {
    const { result, tts } = setup({ tts: fakeTts({ status: "playing", unit: 1 }) });
    act(() => result.current.skip(-1));
    expect(tts.play).not.toHaveBeenCalled();
  });

  it("washes the sentence, the reported word, or the whole block", () => {
    const sentence = setup({ tts: fakeTts({ status: "playing", unit: 1 }) });
    // Sentence level: the whole utterance, in its block's coordinates.
    expect(sentence.result.current.span).toEqual({ source: 0, start: 4, end: 8 });

    // Word level paints nothing until the engine says where the voice is: a
    // sentence-wide wash that snaps down onto a word reads as a flash.
    const waiting = setup({
      granularity: "word",
      tts: fakeTts({ status: "playing", unit: 1 }),
    });
    expect(waiting.result.current.span).toBeNull();

    const word = setup({
      granularity: "word",
      tts: fakeTts({
        status: "playing",
        unit: 1,
        boundary: { unit: 1, charIndex: 2, charLength: 2 },
      }),
    });
    expect(word.result.current.span).toEqual({ source: 0, start: 6, end: 8 });

    // Paragraph level: the whole block the utterance sits in.
    const block = setup({
      granularity: "paragraph",
      tts: fakeTts({ status: "playing", unit: 1 }),
    });
    expect(block.result.current.span).toEqual({ source: 0, start: 0, end: 8 });
  });

  it("expresses the same wash as a needle into a PDF page", () => {
    const { result } = setup({
      isPdf: true,
      tts: fakeTts({
        status: "playing",
        unit: 1,
        boundary: { unit: 1, charIndex: 0, charLength: 0 },
      }),
    });

    // The page anchors on the sentence, so the offsets restart at its own zero.
    expect(result.current.pdfWash).toEqual({ text: "第二句。", from: 0, to: 4 });
  });

  it("keeps the engine in step with the stored rate and the resolved voice", () => {
    const { result, tts } = setup({ rate: 1.25 });

    expect(tts.setRate).toHaveBeenCalledWith(1.25);
    // No stored voice and no catalogue to resolve one from: `null` is "the
    // engine's own default", not a missing value.
    expect(tts.setVoice).toHaveBeenCalledWith(null);

    act(() => result.current.setPlayerOpen(true));
    expect(result.current.playerOpen).toBe(true);
  });

  it("cuts the speed-reading tokens only while the overlay is open", () => {
    const { result } = setup();

    // One shared empty array while closed, so the overlay's run-reset effect
    // never reads a closed overlay as a new chapter.
    const closed = result.current.rsvpWords;
    expect(closed).toEqual([]);

    act(() => result.current.toggleRsvp());
    expect(result.current.rsvpOpen).toBe(true);
    // What the cut produces is `rsvpTokens`'s business; this layer's is *when*
    // it happens at all.
    expect(result.current.rsvpWords).not.toBe(closed);
    expect(result.current.rsvpWords.length).toBeGreaterThan(0);

    act(() => result.current.closeRsvp());
    expect(result.current.rsvpOpen).toBe(false);
    expect(result.current.rsvpWords).toBe(closed);
  });

  it("asks the reader for the section's blocks on the Kindle path", async () => {
    const units: SpeechUnit[] = [
      { text: "A", source: 0, start: 0, end: 1 },
      { text: "B", source: 1, start: 0, end: 1 },
    ];
    const readFrom = vi.fn(() => Promise.resolve(units));
    const { result, tts, options } = setup({
      useFoliate: true,
      foliateRef: { current: fakeHandle({ readFrom }) },
    });

    await act(async () => result.current.toggle());

    expect(readFrom).toHaveBeenCalledTimes(1);
    // The roll-over, not `onChapterEnd`: a finished section hands the voice to
    // the next one rather than walking a chapter that foliate does not have.
    const [, , onFinish] = (tts.play as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(onFinish).not.toBe(options.onChapterEnd);
    expect(tts.play).toHaveBeenCalledWith(["A", "B"], 0, onFinish);
    expect(result.current.units).toEqual(units);
  });

  it("stops the voice when the section it asked for came back empty", async () => {
    const { result, tts } = setup({
      useFoliate: true,
      foliateRef: { current: fakeHandle() },
    });

    await act(async () => result.current.toggle());

    expect(tts.stop).toHaveBeenCalledTimes(1);
    expect(tts.play).not.toHaveBeenCalled();
  });

  it("restarts the prose queue from its first unit for a chapter roll-over", () => {
    const { result, tts, options } = setup();

    act(() => result.current.playFromStart());

    expect(tts.play).toHaveBeenCalledWith(QUEUE, 0, options.onChapterEnd);
  });

  /**
   * `playFromStart` goes into the reader's position effect, and a fresh
   * identity there re-applies the pending scroll — which yanks the page back to
   * the top of the chapter. The reader builds its options object anew on every
   * render, so this is the real case, not a synthetic one.
   */
  it("keeps playFromStart stable across renders of an unchanged chapter", () => {
    const { result, rerender, options } = setup();
    const first = result.current.playFromStart;

    rerender({ ...options });

    expect(result.current.playFromStart).toBe(first);
  });

  /** Stable is not frozen: it closes over the queue and the roll-over, so a
   *  chapter change — or a new roll-over — has to produce a new one. */
  it("rebuilds playFromStart when its continuation changes", () => {
    const { result, rerender, options } = setup();
    const first = result.current.playFromStart;

    rerender({ ...options, onChapterEnd: vi.fn() });

    expect(result.current.playFromStart).not.toBe(first);
  });
});
