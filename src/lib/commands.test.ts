import { describe, expect, it } from "vitest";

import {
  isEditableTarget,
  scoreCommand,
  shortcutMatches,
  type Command,
  type KeyStroke,
} from "@/lib/commands";

function command(title: string, keywords?: readonly string[]): Command {
  return {
    id: `test.${title}`,
    title,
    group: "测试",
    keywords,
    run: () => {},
  };
}

function stroke(key: string, mods: Partial<Omit<KeyStroke, "key">> = {}): KeyStroke {
  return { key, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...mods };
}

describe("scoreCommand", () => {
  const open = command("打开命令面板", ["palette", "命令"]);

  it("scores every command when the query is empty", () => {
    expect(scoreCommand("", open)).toBe(1);
    expect(scoreCommand("   ", open)).toBe(1);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(scoreCommand("xyz", open)).toBeNull();
  });

  it("matches the title case-insensitively", () => {
    expect(scoreCommand("命令面板", open)).toBeGreaterThan(0);
  });

  it("matches keywords as well as the title", () => {
    expect(scoreCommand("palette", open)).toBeGreaterThan(0);
  });

  it("rewards a contiguous prefix match over a scattered one", () => {
    const prefix = scoreCommand("打开", open) ?? 0;
    const scattered = scoreCommand("开命", open) ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("ranks prefix matches above mid-string matches", () => {
    const a = command("设置");
    const b = command("打开设置");
    expect(scoreCommand("设置", a) ?? 0).toBeGreaterThan(scoreCommand("设置", b) ?? 0);
  });
});

/**
 * The two keyboard predicates every matcher in the app shares — `useHotkeys`
 * and the reader's own table. They were written out twice before this, once in
 * each, which is the kind of pair that drifts one bug fix at a time.
 *
 * One branch of `isEditableTarget` is deliberately not asserted: jsdom does not
 * implement `isContentEditable` (it reads false on an element that carries the
 * attribute), and no surface in this app is contenteditable today — the
 * `grep` finds nothing. It is kept as the guard it has always been, with the
 * caveat written down rather than a tautology standing in for a test.
 */
describe("shortcutMatches", () => {
  it("compares the key case-insensitively", () => {
    expect(shortcutMatches(stroke("k"), { key: "k" })).toBe(true);
    expect(shortcutMatches(stroke("K"), { key: "k" })).toBe(true);
    expect(shortcutMatches(stroke("j"), { key: "k" })).toBe(false);
  });

  it("takes mod to mean either Cmd or Ctrl", () => {
    expect(shortcutMatches(stroke("k", { metaKey: true }), { mod: true, key: "k" })).toBe(true);
    expect(shortcutMatches(stroke("k", { ctrlKey: true }), { mod: true, key: "k" })).toBe(true);
    expect(shortcutMatches(stroke("k"), { mod: true, key: "k" })).toBe(false);
    // …and a shortcut with no mod refuses both.
    expect(shortcutMatches(stroke("k", { metaKey: true }), { key: "k" })).toBe(false);
    expect(shortcutMatches(stroke("k", { ctrlKey: true }), { key: "k" })).toBe(false);
  });

  it("treats an unmentioned modifier as a refusal, not a wildcard", () => {
    // This is what keeps Shift+Space from being Space — the reader's own Space
    // binding depends on it.
    expect(shortcutMatches(stroke(" ", { shiftKey: true }), { key: " " })).toBe(false);
    expect(shortcutMatches(stroke(" ", { shiftKey: true }), { shift: true, key: " " })).toBe(true);
    expect(shortcutMatches(stroke("ArrowRight", { altKey: true }), { key: "ArrowRight" })).toBe(
      false,
    );
  });

  it("matches the long key names the pedals send", () => {
    expect(shortcutMatches(stroke("MediaTrackNext"), { key: "MediaTrackNext" })).toBe(true);
    expect(shortcutMatches(stroke("PageDown"), { key: "PageDown" })).toBe(true);
  });
});

describe("isEditableTarget", () => {
  it("recognises the fields that own their own keys", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true);
    }
  });

  it("leaves a plain element, and no element at all, alone", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    // A key arriving from inside the book's iframe has no target here, and it
    // must not be mistaken for a field — the reader's keys work over the page.
    expect(isEditableTarget(null)).toBe(false);
  });
});
