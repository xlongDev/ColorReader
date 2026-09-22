import { describe, expect, it } from "vitest";

import { focusIndex, remainingSeconds, rsvpTokens, tokenDelayMs } from "@/features/reader/rsvp";

describe("rsvpTokens", () => {
  it("splits Latin text into words and keeps their punctuation", () => {
    const tokens = rsvpTokens("The spice must flow, they said.");
    expect(tokens).toContain("flow,");
    expect(tokens).toContain("said.");
    expect(tokens).not.toContain(" ");
  });

  it("splits Chinese into words rather than one run", () => {
    // A whitespace split would hand back the whole sentence as one token,
    // which is exactly why the segmenter is not optional here.
    const tokens = rsvpTokens("他慢慢地走出了那间屋子。");
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.at(-1)).toBe("屋子。");
  });

  it("hangs trailing punctuation on the word before it", () => {
    const tokens = rsvpTokens("好，走吧！");
    expect(tokens.every((token) => /[\p{L}\p{N}]/u.test(token))).toBe(true);
  });

  it("returns nothing for blank text", () => {
    expect(rsvpTokens("   ")).toEqual([]);
  });
});

describe("focusIndex", () => {
  it("walks forward as the word grows", () => {
    expect(focusIndex("我")).toBe(0);
    expect(focusIndex("我们")).toBe(1);
    expect(focusIndex("important")).toBe(2);
    expect(focusIndex("extraordinary")).toBe(3);
    expect(focusIndex("internationalization")).toBe(4);
  });
});

describe("tokenDelayMs", () => {
  it("is one word of the rate for an ordinary word", () => {
    // 300 wpm is 200 ms a word.
    expect(tokenDelayMs("word", 300)).toBe(200);
  });

  it("gives a sentence end a longer beat", () => {
    const plain = tokenDelayMs("ended", 300);
    const stop = tokenDelayMs("ended.", 300);
    expect(stop).toBeGreaterThan(plain * 1.5);
  });

  it("slows a little for a long word", () => {
    expect(tokenDelayMs("understanding", 300)).toBeGreaterThan(tokenDelayMs("word", 300));
  });
});

describe("remainingSeconds", () => {
  it("is the words left over the rate", () => {
    expect(remainingSeconds(600, 0, 300)).toBe(120);
    expect(remainingSeconds(600, 300, 300)).toBe(60);
    expect(remainingSeconds(600, 900, 300)).toBe(0);
  });
});
