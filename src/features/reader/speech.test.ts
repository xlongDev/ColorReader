import { describe, expect, it } from "vitest";

import { segmentText } from "./selection";
import {
  cursorAt,
  formatClock,
  queuePosition,
  speechSeconds,
  speechUnits,
  unitAtChar,
  unitsFromOffset,
  washSpan,
  wordCues,
  wordSpanAt,
  type SpeechUnit,
} from "./speech";

/** One utterance, two sentences long. */
const UNIT: SpeechUnit = {
  text: "Hello world. Second run.",
  source: 0,
  start: 0,
  end: 24,
};

describe("speechUnits", () => {
  it("cuts every block into sentences, whatever the highlight level", () => {
    // The reader's highlight level does not recut the queue: it decides how
    // much of the text the wash covers, and a recut would move the unit the
    // voice is holding out from under it.
    const units = speechUnits([
      { index: 0, text: "第一句。第二句。" },
      { index: 3, text: "第三句。" },
    ]);
    expect(units).toEqual([
      { text: "第一句。", source: 0, start: 0, end: 4 },
      { text: "第二句。", source: 0, start: 4, end: 8 },
      { text: "第三句。", source: 3, start: 0, end: 4 },
    ]);
  });

  it("keeps sentence offsets sliceable out of the raw text", () => {
    const text = "他觉得今天很冷。于是他关上了窗。窗外下着雨。";
    const units = speechUnits([{ index: 1, text }]);
    expect(units.length).toBeGreaterThan(1);
    expect(units.map((unit) => unit.source)).toEqual(units.map(() => 1));
    for (const unit of units) {
      // Exactly the slice: an engine `charIndex` inside the utterance has to
      // map straight back onto the paragraph, or the word wash drifts.
      expect(text.slice(unit.start, unit.end)).toBe(unit.text);
      expect(unit.text).toBe(unit.text.trim());
    }
    // Every sentence is consumed in order, none read twice.
    expect(units.map((unit) => unit.end).toSorted((a, b) => a - b)).toEqual(
      units.map((unit) => unit.end),
    );
  });

  it("drops empty and whitespace-only blocks", () => {
    const units = speechUnits([
      { index: 0, text: "   " },
      { index: 1, text: "" },
      { index: 2, text: "有字。" },
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]?.source).toBe(2);
  });

  it("trims the indentation HTML pretty-printing leaves in front of a run", () => {
    const text = "  一行 文字  ";
    const units = speechUnits([{ index: 0, text }]);
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect(unit.text).toBe(text.slice(unit.start, unit.end));
      expect(unit.text).toBe(unit.text.trim());
    }
    expect(units.map((unit) => unit.text).join("")).toBe("一行 文字");
    expect(units[0]?.start).toBe(2);
  });
});

describe("wordSpanAt", () => {
  it("trusts the length the engine reported", () => {
    expect(wordSpanAt("hello world", 6, 5)).toEqual({ start: 6, end: 11 });
  });

  it("falls back to the word when the engine reports only a start", () => {
    const span = wordSpanAt("hello world", 6, 0);
    expect(span.start).toBeLessThanOrEqual(6);
    expect(span.end).toBeGreaterThan(6);
  });

  it("never returns an empty span", () => {
    const span = wordSpanAt("字", 0, 0);
    expect(span.end).toBeGreaterThan(span.start);
  });
});

describe("segmentText with a read-aloud run", () => {
  it("marks the spoken run and lets it win over a touching annotation", () => {
    const segments = segmentText("今天很冷。", [
      { range: [0, 4], id: "a1" },
      { range: [2, 4], tts: true },
    ]);
    expect(segments.map((segment) => segment.text)).toEqual(["今天", "很冷", "。"]);
    expect(segments[1]).toMatchObject({ tts: true, annotationId: "a1" });
    expect(segments[0]?.annotationId).toBe("a1");
    expect(segments[2]).toMatchObject({ highlighted: false });
  });
});

describe("the read-aloud clock", () => {
  it("counts characters already spoken and the queue's whole length", () => {
    const units = speechUnits([
      { index: 0, text: "一二三。" },
      { index: 1, text: "四五六。" },
    ]);
    expect(queuePosition(units, 1)).toEqual({ spoken: 4, total: 8 });
    expect(queuePosition(units, null)).toEqual({ spoken: 0, total: 8 });
  });

  it("reads faster at a higher rate", () => {
    expect(speechSeconds(300, 2)).toBe(speechSeconds(300, 1) / 2);
  });

  it("maps a scrubber position back onto the utterance covering it", () => {
    const units = speechUnits([
      { index: 0, text: "一二三。" },
      { index: 1, text: "四五六。" },
    ]);
    expect(unitAtChar(units, 0)).toBe(0);
    expect(unitAtChar(units, 3)).toBe(0);
    expect(unitAtChar(units, 4)).toBe(1);
    // Past the end clamps to the last utterance rather than returning nothing.
    expect(unitAtChar(units, 999)).toBe(1);
  });

  it("formats the clock and rolls into hours", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(569)).toBe("9:29");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(-4)).toBe("0:00");
  });
});

describe("washSpan", () => {
  it("washes the whole utterance at sentence granularity", () => {
    expect(washSpan(0, UNIT, null, "sentence")).toEqual({ start: 0, end: 24 });
  });

  it("measures the wash in the block's own coordinates", () => {
    // A unit in the middle of its block: the wash has to carry the block-local
    // start, since that is what the page paints against.
    const inner: SpeechUnit = { text: "Second run.", source: 0, start: 13, end: 24 };
    expect(washSpan(0, inner, null, "sentence")).toEqual({ start: 13, end: 24 });
  });

  it("washes nothing at word granularity until the engine reports", () => {
    // The whole point: no sentence-wide wash that snaps down onto a word.
    expect(washSpan(0, UNIT, null, "word")).toBeNull();
    expect(washSpan(0, UNIT, { unit: 1, charIndex: 0, charLength: 5 }, "word")).toBeNull();
  });

  it("narrows to the reported word", () => {
    const span = washSpan(0, UNIT, { unit: 0, charIndex: 6, charLength: 5 }, "word");
    expect(span).toEqual({ start: 6, end: 11 });
  });

  it("reads the engine's offsets against the trimmed utterance", () => {
    // 「朗读此处」 cut 6 characters off the head; the engine counts from there.
    const span = washSpan(0, UNIT, { unit: 0, charIndex: 0, charLength: 5 }, "word", 6);
    expect(span).toEqual({ start: 6, end: 11 });
  });

  it("washes the whole block at paragraph level, from its own zero", () => {
    const inner: SpeechUnit = { text: "Second run.", source: 0, start: 13, end: 24 };
    expect(washSpan(0, inner, null, "paragraph", 0, 60)).toEqual({ start: 0, end: 60 });
    // Level first: the head trim 「朗读此处」 left is not where the wash starts.
    expect(washSpan(0, inner, null, "paragraph", 6, 60)).toEqual({ start: 0, end: 60 });
    // With no block given, the utterance's own end stands in.
    expect(washSpan(0, UNIT, null, "paragraph")).toEqual({ start: 0, end: 24 });
  });

  it("takes a whole-utterance report as the word position", () => {
    // The blind-voice fallback: the engine hands its whole text over.
    const span = washSpan(0, UNIT, { unit: 0, charIndex: 0, charLength: 24 }, "word");
    expect(span).toEqual({ start: 0, end: 24 });
  });
});

describe("cursorAt", () => {
  const units = speechUnits([
    { index: 0, text: "第一句。第二句。" },
    { index: 1, text: "第三句。" },
  ]);

  it("lands on the utterance holding the offset", () => {
    expect(cursorAt(units, 0, 0)).toEqual({ index: 0, trim: 0 });
    expect(cursorAt(units, 0, 3)).toEqual({ index: 0, trim: 3 });
    expect(cursorAt(units, 1, 1)).toEqual({ index: 2, trim: 1 });
  });

  it("does not trim when the offset falls in an earlier block", () => {
    expect(cursorAt(units, 0, 4)).toEqual({ index: 1, trim: 0 });
  });

  it("reports nothing to read past the last utterance", () => {
    expect(cursorAt(units, 9, 0).index).toBe(-1);
  });
});

describe("unitsFromOffset", () => {
  const units = speechUnits([{ index: 0, text: "第一句。第二句。" }]);

  it("trims the first utterance to the reader's own position", () => {
    const queue = unitsFromOffset(units, 0, 5);
    expect(queue[0]?.text).toBe("二句。");
    // The offsets stay honest, so the wash still lines up with the page.
    expect(queue[0]?.start).toBe(5);
    expect(queue).toHaveLength(1);
  });

  it("leaves the utterance whole when the offset is at its head", () => {
    expect(unitsFromOffset(units, 0, 0)[0]?.text).toBe("第一句。");
  });

  it("comes back empty when nothing follows", () => {
    expect(unitsFromOffset(units, 9, 0)).toEqual([]);
  });
});

describe("wordCues", () => {
  it("maps timed words onto the characters they were spoken from", () => {
    const cues = wordCues("你好，世界。", [
      { at: 0, text: "你好" },
      { at: 0.8, text: "世界" },
    ]);
    expect(cues).toEqual([
      { at: 0, start: 0, end: 2 },
      { at: 0.8, start: 3, end: 5 },
    ]);
  });

  it("maps a repeated word to the occurrence being spoken, not the first", () => {
    const cues = wordCues("好，好。", [
      { at: 0, text: "好" },
      { at: 0.6, text: "好" },
    ]);
    expect(cues.map((cue) => cue.start)).toEqual([0, 2]);
  });

  it("drops a word the text does not contain instead of guessing an offset", () => {
    const cues = wordCues("共 1 页。", [
      { at: 0, text: "共" },
      { at: 0.4, text: "一" },
      { at: 0.9, text: "页" },
    ]);
    expect(cues.map((cue) => cue.start)).toEqual([0, 4]);
  });

  it("ignores an empty word", () => {
    expect(wordCues("中文", [{ at: 0, text: "" }])).toEqual([]);
  });

  it("has nothing to map when the engine timed nothing", () => {
    expect(wordCues("中文", [])).toEqual([]);
  });
});
