import { describe, expect, it } from "vitest";

import {
  effectiveKeys,
  formatShortcut,
  isEditableTarget,
  scoreCommand,
  sharedShortcuts,
  shortcutFromStroke,
  shortcutMatches,
  type Command,
  type KeyStroke,
  type Shortcut,
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

/** A rebindable entry, as `sharedShortcuts` sees one. */
function entry(id: string, title: string, keys: readonly Shortcut[]) {
  return { id, title, keys };
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

/**
 * The rebind panel writes these and reads them back: `shortcutFromStroke` is
 * what a recorded press turns into, `formatShortcut` is what the row shows,
 * and `effectiveKeys` is what every consumer asks instead of reading
 * `command.shortcut` directly. They are asserted together because the round
 * trip is the contract — a key recorded as `⌘ K` has to read back as one.
 */
describe("formatShortcut", () => {
  it("writes the modifiers in the order a keyboard prints them", () => {
    expect(formatShortcut({ mod: true, shift: true, alt: true, key: "k" })).toBe("⌘ ⇧ ⌥ K");
  });

  it("leaves out the modifiers that are not on", () => {
    expect(formatShortcut({ key: "k" })).toBe("K");
    expect(formatShortcut({ mod: true, key: "k" })).toBe("⌘ K");
    // Shift is written even though it also changes the character: the key
    // stored is the one the press reported, and the badge has to say so.
    expect(formatShortcut({ shift: true, key: "K" })).toBe("⇧ K");
  });

  it("spells the keys a keycap cannot show", () => {
    expect(formatShortcut({ key: "ArrowRight" })).toBe("→");
    expect(formatShortcut({ key: "ArrowLeft" })).toBe("←");
    expect(formatShortcut({ key: " " })).toBe("空格");
    expect(formatShortcut({ key: "PageDown" })).toBe("PgDn");
    expect(formatShortcut({ key: "Escape" })).toBe("Esc");
    expect(formatShortcut({ key: "MediaTrackNext" })).toBe("媒体下一曲");
  });

  it("looks the label up case-insensitively", () => {
    expect(formatShortcut({ key: "arrowright" })).toBe("→");
    expect(formatShortcut({ key: "ESCAPE" })).toBe("Esc");
  });

  it("prints a single character the way a keycap does, and shouts no names", () => {
    // The recorder stores what the press reported, which for a letter is
    // lowercase — but a keycap prints `K`.
    expect(formatShortcut({ key: "k" })).toBe("K");
    expect(formatShortcut({ key: "1" })).toBe("1");
    // …and a name of several characters is left alone rather than shouted:
    // `MEDIATRACKNEXT` is the bug this replaced.
    expect(formatShortcut({ key: "F5" })).toBe("F5");
    expect(formatShortcut({ key: "F11" })).toBe("F11");
    expect(formatShortcut({ key: "Numpad5" })).toBe("Numpad5");
  });
});

describe("shortcutFromStroke", () => {
  it("takes mod to mean Cmd or Ctrl", () => {
    expect(shortcutFromStroke(stroke("k", { metaKey: true }))).toEqual({ mod: true, key: "k" });
    expect(shortcutFromStroke(stroke("k", { ctrlKey: true }))).toEqual({ mod: true, key: "k" });
  });

  it("writes only the modifiers that are on", () => {
    // This is what makes a recorded binding compare equal to a hand-written
    // default: `{ shift: false }` and an absent `shift` have to be the same
    // object shape, or the stored JSON grows keys nobody set.
    expect(shortcutFromStroke(stroke("k"))).toEqual({ key: "k" });
    expect(Object.keys(shortcutFromStroke(stroke("k")) ?? {})).toEqual(["key"]);
  });

  it("refuses the keys that are not keys", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Unidentified"]) {
      expect(shortcutFromStroke(stroke(key))).toBeNull();
    }
  });

  it("allows Escape through", () => {
    // The recorder is what refuses Escape, so that Escape can stay the way out
    // of the recorder. The stroke converter has no opinion on it.
    expect(shortcutFromStroke(stroke("Escape"))).toEqual({ key: "Escape" });
  });
});

describe("effectiveKeys", () => {
  const fallback = [{ key: "k", mod: true }];

  it("returns the override when there is one", () => {
    const override = [{ key: "j", mod: true, shift: true }];
    expect(effectiveKeys("app.palette", fallback, { "app.palette": override })).toBe(override);
  });

  it("returns the default when the id is absent", () => {
    expect(effectiveKeys("app.palette", fallback, {})).toBe(fallback);
    expect(effectiveKeys("app.palette", fallback, { "app.other": [] })).toBe(fallback);
  });

  it("reports an id with no default and no override as unbound", () => {
    // `useHotkeys` skips these; the panel lists nothing for them either.
    expect(effectiveKeys("app.nothing", undefined, {})).toBeUndefined();
  });
});

describe("sharedShortcuts", () => {
  it("reports a combination two entries answer to", () => {
    const shared = sharedShortcuts([
      entry("a", "甲", [{ mod: true, key: "k" }]),
      entry("b", "乙", [{ mod: true, key: "k" }]),
      entry("c", "丙", [{ key: "j" }]),
    ]);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.ids).toEqual(["a", "b"]);
    expect(shared[0]?.titles).toEqual(["甲", "乙"]);
    expect(shared[0]?.shortcut).toEqual({ mod: true, key: "k" });
  });

  it("says nothing about entries that do not collide", () => {
    expect(
      sharedShortcuts([entry("a", "甲", [{ key: "k" }]), entry("b", "乙", [{ key: "j" }])]),
    ).toEqual([]);
  });

  it("compares case-insensitively and mod against Cmd or Ctrl", () => {
    // `K` and `k` are one key; `mod` is the only spelling of ⌘/Ctrl there is.
    expect(
      sharedShortcuts([entry("a", "甲", [{ key: "K" }]), entry("b", "乙", [{ key: "k" }])]),
    ).toHaveLength(1);
    expect(
      sharedShortcuts([
        entry("a", "甲", [{ key: "k" }]),
        entry("b", "乙", [{ key: "k", mod: true }]),
      ]),
    ).toEqual([]);
  });

  it("does not report an entry against itself", () => {
    // One binding listing a key twice is a typo in the table, not a clash, and
    // reporting it would render as 「甲」和「甲」.
    expect(sharedShortcuts([entry("a", "甲", [{ key: "k" }, { key: "k" }])])).toEqual([]);
  });

  it("collapses a triple into one line", () => {
    const shared = sharedShortcuts([
      entry("a", "甲", [{ key: "k" }]),
      entry("b", "乙", [{ key: "k" }]),
      entry("c", "丙", [{ key: "k" }]),
    ]);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.ids).toEqual(["a", "b", "c"]);
  });
});
