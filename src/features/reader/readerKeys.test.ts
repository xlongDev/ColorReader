import { describe, expect, it } from "vitest";

import {
  bindingKeys,
  READER_KEYS,
  resolveReaderKey,
  unreachableBindings,
  type ReaderKeyContext,
} from "@/features/reader/readerKeys";
import type { KeyOverrides, KeyStroke } from "@/lib/commands";

/**
 * The reader's keyboard, as a decision table.
 *
 * None of this had a test before: it was a branch chain inside `ReaderPage`
 * that only the browser suite could reach. The pairs below are the ones that
 * cost something to get wrong — the lightbox taking the keyboard away, the
 * ruler and the page turns sharing Left/Right, the scrolled layout leaving the
 * browser's own Space alone.
 */

function stroke(key: string, mods: Partial<Omit<KeyStroke, "key">> = {}): KeyStroke {
  return { key, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...mods };
}

const context = (over: Partial<ReaderKeyContext> = {}): ReaderKeyContext => ({
  lightboxOpen: false,
  rulerOn: false,
  paged: false,
  readsLeftward: false,
  ...over,
});

/** The id a press resolves to, or `null`. */
const press = (key: string, over?: Partial<ReaderKeyContext>, mods?: Partial<KeyStroke>) =>
  resolveReaderKey(stroke(key, mods), context(over))?.id ?? null;

describe("resolveReaderKey", () => {
  it("hands the keyboard to the lightbox while it is up", () => {
    const open = { lightboxOpen: true };
    expect(press("Escape", open)).toBe("reader.lightbox.close");
    expect(press("ArrowRight", open)).toBe("reader.lightbox.next");
    expect(press("ArrowLeft", open)).toBe("reader.lightbox.prev");
  });

  it("lets nothing else claim a key while the lightbox is up", () => {
    // The lightbox is modal. Each row is a press that is the reading layout's
    // with the lightbox closed and either the lightbox's or nobody's with it
    // open — which is what the early return in the old handler did, one key at
    // a time. (The arrows it does claim are in the test above.)
    const rows: Array<[string, Partial<ReaderKeyContext>, string, string | null]> = [
      // key, context, with no lightbox, with the lightbox up
      ["ArrowDown", { rulerOn: true }, "reader.ruler.forward", null],
      ["ArrowUp", { rulerOn: true }, "reader.ruler.back", null],
      [
        "ArrowRight",
        { rulerOn: true, paged: true },
        "reader.ruler.forward",
        "reader.lightbox.next",
      ],
      ["PageDown", { paged: true }, "reader.page.next", null],
      ["PageUp", { paged: true }, "reader.page.prev", null],
      [" ", { paged: true }, "reader.page.next", null],
      ["MediaTrackNext", { paged: true }, "reader.page.next", null],
    ];
    for (const [key, over, closed, open] of rows) {
      expect(press(key, { ...over, lightboxOpen: false })).toBe(closed);
      expect(press(key, { ...over, lightboxOpen: true })).toBe(open);
    }
  });

  it("gives Escape to the floating surfaces when no image is up", () => {
    expect(press("Escape")).toBe("reader.dismiss");
    // The drawer is closed with Escape while the caret is in its own search
    // field, so this is the one binding that must survive the editable guard.
    expect(resolveReaderKey(stroke("Escape"), context())?.inEditable).toBe(true);
    // …and its own action is never stopped: in the browser build Esc leaving
    // fullscreen is the browser's doing.
    expect(resolveReaderKey(stroke("Escape"), context())?.keepDefault).toBe(true);
  });

  it("turns pages with the arrows, the pedals and Space in a paged layout", () => {
    const paged = { paged: true };
    expect(press("ArrowRight", paged)).toBe("reader.turn.right");
    expect(press("ArrowLeft", paged)).toBe("reader.turn.left");
    expect(press("PageDown", paged)).toBe("reader.page.next");
    expect(press("MediaTrackNext", paged)).toBe("reader.page.next");
    expect(press(" ", paged)).toBe("reader.page.next");
    expect(press("PageUp", paged)).toBe("reader.page.prev");
    expect(press("MediaTrackPrevious", paged)).toBe("reader.page.prev");
  });

  it("steps chapters with the arrows in the scrolled layout, and leaves the pedals alone", () => {
    const scroll = { paged: false };
    expect(press("ArrowRight", scroll)).toBe("reader.chapter.next");
    expect(press("ArrowLeft", scroll)).toBe("reader.chapter.prev");
    // Space and PageDown are the browser's own way down a continuous flow.
    expect(press(" ", scroll)).toBeNull();
    expect(press("PageDown", scroll)).toBeNull();
    expect(press("MediaTrackNext", scroll)).toBeNull();
  });

  it("gives the band the arrows while the ruler is on", () => {
    const ruler = { rulerOn: true, paged: true };
    expect(press("ArrowDown", ruler)).toBe("reader.ruler.forward");
    expect(press("ArrowUp", ruler)).toBe("reader.ruler.back");
    // Horizontal type reads down the page, so Left/Right are the same step.
    expect(press("ArrowRight", ruler)).toBe("reader.ruler.forward");
    expect(press("ArrowLeft", ruler)).toBe("reader.ruler.back");
  });

  it("leaves Left/Right to the page turns in vertical type, ruler or not", () => {
    // Vertical type reads leftward, where Left/Right are the page turns the
    // reader already knows — so the band only walks on Up/Down, and the same
    // two keys fall through to the turn binding below it.
    const vertical = { rulerOn: true, paged: true, readsLeftward: true };
    expect(press("ArrowRight", vertical)).toBe("reader.turn.right");
    expect(press("ArrowLeft", vertical)).toBe("reader.turn.left");
    expect(press("ArrowDown", vertical)).toBe("reader.ruler.forward");
    expect(press("ArrowUp", vertical)).toBe("reader.ruler.back");
  });

  it("leaves Left/Right to the chapter steps in a scrolled layout with the ruler on", () => {
    // The band walks a continuous flow up and down only; the horizontal arrows
    // keep meaning what they mean in that layout.
    const scrollRuler = { rulerOn: true, paged: false };
    expect(press("ArrowRight", scrollRuler)).toBe("reader.chapter.next");
    expect(press("ArrowLeft", scrollRuler)).toBe("reader.chapter.prev");
    expect(press("ArrowDown", scrollRuler)).toBe("reader.ruler.forward");
  });

  it("does not answer to modified presses", () => {
    // Every binding here is a bare key: `shortcutMatches` compares modifiers
    // for equality, so ⌘→ and ⇧Space are nobody's.
    expect(press("ArrowRight", { paged: true }, { metaKey: true })).toBeNull();
    expect(press("ArrowRight", { paged: true }, { ctrlKey: true })).toBeNull();
    expect(press("ArrowRight", { paged: true }, { altKey: true })).toBeNull();
    expect(press("ArrowRight", { paged: true }, { shiftKey: true })).toBeNull();
    expect(press(" ", { paged: true }, { shiftKey: true })).toBeNull();
  });

  it("gives every binding an id of its own", () => {
    const ids = READER_KEYS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares no key that no context can reach", () => {
    // The guards and the declared keys are written separately, so this is the
    // one test that can catch them disagreeing: a key listed on a binding whose
    // gate never accepts it is a key that silently does nothing.
    const contexts: ReaderKeyContext[] = [];
    for (const lightboxOpen of [false, true]) {
      for (const rulerOn of [false, true]) {
        for (const paged of [false, true]) {
          for (const readsLeftward of [false, true]) {
            contexts.push({ lightboxOpen, rulerOn, paged, readsLeftward });
          }
        }
      }
    }
    const reachable = new Set<string>();
    for (const ctx of contexts) {
      for (const binding of READER_KEYS) {
        for (const key of binding.keys) {
          if (resolveReaderKey(stroke(key.key), ctx)?.id === binding.id) {
            reachable.add(`${binding.id} ${key.key}`);
          }
        }
      }
    }
    const declared = READER_KEYS.flatMap((binding) =>
      binding.keys.map((key) => `${binding.id} ${key.key}`),
    );
    expect(declared.filter((entry) => !reachable.has(entry))).toEqual([]);
  });
});

/** The id a press resolves to once the reader has rebound something. */
const pressWith = (
  key: string,
  over: Partial<ReaderKeyContext>,
  overrides: KeyOverrides,
  mods?: Partial<KeyStroke>,
) => resolveReaderKey(stroke(key, mods), context(over), overrides)?.id ?? null;

const binding = (id: string) => {
  const found = READER_KEYS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no such binding: ${id}`);
  return found;
};

/**
 * What a rebind does to the table.
 *
 * The panel writes `overrides` and everything downstream — the resolver, the
 * palette, the row's own badge — reads through `bindingKeys`. An override
 * *replaces* the binding's keys rather than adding to them, which is the one
 * thing that has to hold for the panel to be able to take a key away at all.
 */
describe("bindingKeys", () => {
  it("hands back the binding's own keys when nothing was rebound", () => {
    expect(bindingKeys(binding("reader.chapter.next"), {})).toBe(
      binding("reader.chapter.next").keys,
    );
  });

  it("hands back the override instead, not as well", () => {
    const overrides: KeyOverrides = { "reader.chapter.next": [{ key: "n" }] };
    expect(bindingKeys(binding("reader.chapter.next"), overrides)).toEqual([{ key: "n" }]);
  });
});

describe("resolveReaderKey with overrides", () => {
  it("answers to the new key and no longer to the old one", () => {
    const overrides: KeyOverrides = { "reader.chapter.next": [{ key: "n" }] };
    expect(pressWith("n", { paged: false }, overrides)).toBe("reader.chapter.next");
    expect(pressWith("ArrowRight", { paged: false }, overrides)).toBeNull();
  });

  it("still respects the gate the key was rebound into", () => {
    // `reader.page.next` only claims a key in a paged layout, and a rebind
    // changes which key that is — not when it applies.
    const overrides: KeyOverrides = { "reader.page.next": [{ key: "n" }] };
    expect(pressWith("n", { paged: true }, overrides)).toBe("reader.page.next");
    expect(pressWith("n", { paged: false }, overrides)).toBeNull();
  });

  it("carries a modifier into the table", () => {
    const overrides: KeyOverrides = { "reader.chapter.next": [{ key: "n", mod: true }] };
    expect(pressWith("n", { paged: false }, overrides, { metaKey: true })).toBe(
      "reader.chapter.next",
    );
    expect(pressWith("n", { paged: false }, overrides)).toBeNull();
  });

  it("leaves a rebound global command out of the reader's table", () => {
    // One record holds both id spaces; the reader only ever looks up its own.
    const overrides: KeyOverrides = { "app.palette": [{ key: "n" }] };
    expect(pressWith("n", { paged: false }, overrides)).toBeNull();
  });
});

/**
 * The panel's warning line.
 *
 * A rebind can leave a binding with no context to win in, and the reader has
 * no way to find that out except by pressing the key and watching nothing
 * happen. The shipped table has to be clean, and each way of breaking it has
 * to be reported with the right culprit — including the case where there is no
 * culprit, because the binding's own gate refuses every key it now has.
 *
 * The takers are compared sorted: which of them is found first is the order the
 * sixteen contexts are enumerated in, which is not something a reader cares
 * about and not something this test should pin.
 */
const conflicts = (overrides: KeyOverrides) =>
  unreachableBindings(overrides).map((entry) => ({
    blocked: entry.blocked.id,
    by: entry.by.map((taker) => taker.id).toSorted(),
  }));

describe("unreachableBindings", () => {
  it("finds nothing wrong with the table as it ships", () => {
    expect(unreachableBindings()).toEqual([]);
    expect(unreachableBindings({})).toEqual([]);
  });

  it("names whoever took the keys", () => {
    // `reader.chapter.prev` sits below `reader.chapter.next`, so giving the
    // former the latter's key leaves it with nothing. Three things hold
    // ArrowRight between them: the chapter step in a scrolled layout, the page
    // turn in a paged one, and the band while the ruler is on.
    expect(conflicts({ "reader.chapter.prev": [{ key: "ArrowRight" }] })).toEqual([
      {
        blocked: "reader.chapter.prev",
        by: ["reader.chapter.next", "reader.ruler.forward", "reader.turn.right"],
      },
    ]);
  });

  it("catches a key taken by the top of the table", () => {
    // `reader.dismiss` is first and always claims Escape, so a page turn bound
    // to Escape can never win.
    expect(conflicts({ "reader.page.next": [{ key: "Escape" }] })).toEqual([
      { blocked: "reader.page.next", by: ["reader.dismiss"] },
    ]);
  });

  it("catches a key taken inside the lightbox's own table", () => {
    // The lightbox swaps the table, so its three bindings only ever compete
    // with each other — and `close` is above `next`. Nothing from the reading
    // table is named here even though it also holds Escape: that table is not
    // in force while the lightbox is up, so it never took this key.
    expect(conflicts({ "reader.lightbox.next": [{ key: "Escape" }] })).toEqual([
      { blocked: "reader.lightbox.next", by: ["reader.lightbox.close"] },
    ]);
  });

  it("reports a binding its own gate refuses, with nobody to blame", () => {
    // The band only walks on the four arrows, so a forward step rebound to
    // `KeyQ` is a key its gate will never accept — and nothing else in the
    // table claims that key, so there is no one to name.
    expect(conflicts({ "reader.ruler.forward": [{ key: "KeyQ" }] })).toEqual([
      { blocked: "reader.ruler.forward", by: [] },
    ]);
  });

  it("still names the taker when the gate is what refuses the key", () => {
    // ArrowUp is the *backward* step's key, so a forward step rebound to it is
    // refused by its own gate — and the binding below answers instead.
    expect(conflicts({ "reader.ruler.forward": [{ key: "ArrowUp" }] })).toEqual([
      { blocked: "reader.ruler.forward", by: ["reader.ruler.back"] },
    ]);
  });

  it("says nothing about a binding that merely lost contexts", () => {
    // The same key on two bindings is the table's normal state, and a rebind
    // that narrows one is not a mistake: `reader.turn.right` on ArrowDown still
    // wins wherever the ruler is off.
    expect(unreachableBindings({ "reader.turn.right": [{ key: "ArrowDown" }] })).toEqual([]);
  });

  it("clears once the override is dropped", () => {
    expect(conflicts({ "reader.chapter.prev": [{ key: "ArrowRight" }] })).toHaveLength(1);
    expect(unreachableBindings({ "reader.chapter.prev": [{ key: "ArrowLeft" }] })).toEqual([]);
  });
});
