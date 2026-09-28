import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useImageLightbox } from "@/hooks/useImageLightbox";
import type { BookImage } from "@/types/ipc";

/** The book's own list, as the importer collects it: paths in book order. */
const BOOK: BookImage[] = [
  { chapterIdx: 0, path: "OEBPS/images/fig1.png" },
  { chapterIdx: 1, path: "OEBPS/images/fig2.png" },
  { chapterIdx: 2, path: "OEBPS/images/fig3.png" },
];

/** Takes an options object rather than a bare list: `undefined` is a case of
 *  its own (the query has not landed), and a default parameter would swallow
 *  it. */
function setup(options: { book: BookImage[] | undefined } = { book: BOOK }) {
  return renderHook((props: { book: BookImage[] | undefined }) => useImageLightbox(props.book), {
    initialProps: options,
  });
}

describe("useImageLightbox", () => {
  it("starts closed, with the book's own list", () => {
    const { result } = setup();
    expect(result.current.path).toBeNull();
    expect(result.current.index).toBeNull();
    expect(result.current.images).toBe(BOOK);
    expect(result.current.urls).toEqual({});
  });

  it("opens the picture at a position, and reports where it sits", () => {
    const { result } = setup();

    act(() => result.current.openAt(2));

    expect(result.current.path).toBe("OEBPS/images/fig3.png");
    expect(result.current.index).toBe(2);
  });

  it("closes rather than opening somebody else's picture when the position is off the list", () => {
    const { result } = setup();
    act(() => result.current.openAt(9));
    expect(result.current.path).toBeNull();
  });

  /**
   * Note what this pins: the *behaviour* (the viewer stays in the book), not
   * the `Math.min/Math.max` clamp in `step`. Those are redundant — an index
   * past either end of a JS array reads `undefined`, and the `?? current`
   * fallback already answers with the picture it is on — so deleting the clamp
   * leaves this green. It is kept for the reader, not for the machine.
   */
  it("steps through the book and stays inside it", () => {
    const { result } = setup();
    act(() => result.current.openAt(1));

    act(() => result.current.step(1));
    expect(result.current.index).toBe(2);

    // The end of the book is the end: stepping past it stays on the last one.
    act(() => result.current.step(1));
    expect(result.current.index).toBe(2);

    act(() => result.current.step(-1));
    expect(result.current.index).toBe(1);
    act(() => result.current.step(-1));
    act(() => result.current.step(-1));
    expect(result.current.index).toBe(0);
  });

  it("steps nothing while the viewer is closed", () => {
    const { result } = setup();
    act(() => result.current.step(1));
    expect(result.current.path).toBeNull();
  });

  it("closes", () => {
    const { result } = setup();
    act(() => result.current.openAt(0));
    act(() => result.current.close());
    expect(result.current.path).toBeNull();
    expect(result.current.index).toBeNull();
  });

  /**
   * The reason the viewer is addressed by path. A picture registered from a
   * click before the importer's list arrived is not in that list — and once the
   * list *does* arrive it may sit at a different position, so an index would
   * silently point at whatever moved into its place.
   */
  it("keeps the same picture open when the book's list arrives", () => {
    const { result, rerender } = setup({ book: undefined });

    // The browser build: nothing from the importer, so a click registers the
    // picture and the viewer opens on it.
    act(() => result.current.openFromBook("OEBPS/images/fig2.png", "blob:fig2"));
    expect(result.current.path).toBe("OEBPS/images/fig2.png");
    expect(result.current.index).toBe(0);

    // Now the importer's list lands, with fig2 second rather than first.
    rerender({ book: BOOK });

    expect(result.current.images).toBe(BOOK);
    expect(result.current.path).toBe("OEBPS/images/fig2.png");
    expect(result.current.index).toBe(1);
  });

  it("registers a clicked picture with its blob URL, once", () => {
    const { result } = setup({ book: undefined });

    act(() => result.current.openFromBook("b.png", "blob:b", 2));
    act(() => result.current.openFromBook("a.png", "blob:a", 0));
    // Clicking the same picture again must not add a second row.
    act(() => result.current.openFromBook("b.png", "blob:b2", 2));

    // Registered in section order, so the viewer walks the book's order.
    expect(result.current.images).toEqual([
      { chapterIdx: 0, path: "a.png" },
      { chapterIdx: 2, path: "b.png" },
    ]);
    // The URL is the latest one the engine handed over.
    expect(result.current.urls).toEqual({ "a.png": "blob:a", "b.png": "blob:b2" });
    expect(result.current.path).toBe("b.png");
  });

  it("falls back to the registered list while the importer's has nothing", () => {
    const { result } = setup({ book: [] });
    act(() => result.current.openFromBook("a.png", "blob:a"));
    expect(result.current.images).toEqual([{ chapterIdx: 0, path: "a.png" }]);
    // An empty book list is not "the book has no pictures": it is "the query
    // has not landed", and the registered list is what there is.
    expect(result.current.index).toBe(0);
  });

  it("opens a clicked entry by exact path", () => {
    const { result } = setup();
    act(() => result.current.openFromBook("OEBPS/images/fig2.png"));
    expect(result.current.index).toBe(1);
  });

  /**
   * The importer stores the entry name as the container spells it, while
   * foliate decodes percent escapes before resolving — so the same file can
   * arrive spelled two ways. Same basename, same file.
   */
  it("matches a clicked entry that arrived percent-encoded", () => {
    const book: BookImage[] = [{ chapterIdx: 0, path: "OEBPS/images/长 名.png" }];
    const { result } = setup({ book });

    act(() => result.current.openFromBook("OEBPS/images/%E9%95%BF%20%E5%90%8D.png"));

    expect(result.current.path).toBe("OEBPS/images/长 名.png");
    expect(result.current.index).toBe(0);
  });

  it("opens nothing for an entry the importer skipped", () => {
    const { result } = setup();
    // Rare (an image used only by the book's own CSS), and the alternative —
    // the first picture opening in its place — is worse than nothing.
    act(() => result.current.openFromBook("OEBPS/images/unknown.png"));
    expect(result.current.path).toBeNull();
  });

  /** `close` goes into the reader's key handler dependency list, so a fresh
   *  identity would re-bind the listener on every render. */
  it("keeps close identity-stable across renders", () => {
    const { result, rerender } = setup();
    const first = result.current.close;
    rerender({ book: BOOK });
    expect(result.current.close).toBe(first);
  });
});
