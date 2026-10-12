import { describe, expect, it } from "vitest";

import { READER_KEYS, resolveReaderKey, type ReaderKeyContext } from "@/features/reader/readerKeys";
import type { KeyStroke } from "@/lib/commands";

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
