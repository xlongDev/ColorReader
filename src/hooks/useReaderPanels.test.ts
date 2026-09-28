import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useReaderPanels } from "@/hooks/useReaderPanels";

/**
 * The reason this hook exists is `close`, so that is what is pinned here: the
 * query and the painted match highlights both have to go with the drawer, on
 * every way out. The bug that prompted the extraction was Escape clearing the
 * query and leaving foliate's highlights painted on the page.
 */
/** A render whose `clearPainted` spy can be handed in and read back. Module
 *  scope so it is not rebuilt on every case. */
function setup(clear = vi.fn()) {
  return renderHook(({ clearPainted }) => useReaderPanels("", clearPainted), {
    initialProps: { clearPainted: clear },
  });
}

describe("useReaderPanels", () => {
  it("opens on nothing, with the query it was seeded with", () => {
    const { result } = renderHook(() => useReaderPanels("三体", () => {}));
    expect(result.current.panel).toBe("none");
    expect(result.current.search).toBe("三体");
  });

  it("toggle opens the panel it names, and the same id closes it", () => {
    const { result } = renderHook(() => useReaderPanels("", () => {}));

    act(() => result.current.toggle("toc"));
    expect(result.current.panel).toBe("toc");

    act(() => result.current.toggle("toc"));
    expect(result.current.panel).toBe("none");

    // A different id moves the drawer rather than closing it: only one panel
    // is ever open.
    act(() => result.current.toggle("toc"));
    act(() => result.current.toggle("annotations"));
    expect(result.current.panel).toBe("annotations");
  });

  it("close clears the query and the painted matches when the search drawer was open", () => {
    const clearPainted = vi.fn();
    const { result } = setup(clearPainted);

    act(() => result.current.setPanel("search"));
    act(() => result.current.setSearch("kittens"));

    let closed = false;
    act(() => {
      closed = result.current.close();
    });

    expect(closed).toBe(true);
    expect(result.current.panel).toBe("none");
    expect(result.current.search).toBe("");
    expect(clearPainted).toHaveBeenCalledTimes(1);
  });

  it("close on another panel takes nothing with it", () => {
    const clearPainted = vi.fn();
    const { result } = setup(clearPainted);

    act(() => result.current.setPanel("toc"));
    act(() => {
      result.current.close();
    });

    expect(result.current.panel).toBe("none");
    // Nothing was searched, so there is nothing painted to clear — and the
    // query the drawer would open with stays whatever the reader left.
    expect(clearPainted).not.toHaveBeenCalled();
  });

  it("close with nothing open reports that it consumed nothing", () => {
    const clearPainted = vi.fn();
    const { result } = setup(clearPainted);

    let closed = true;
    act(() => {
      closed = result.current.close();
    });

    // The key handler uses this to decide whether Escape belongs to the panel
    // or should fall through to the fullscreen toggle.
    expect(closed).toBe(false);
    expect(clearPainted).not.toHaveBeenCalled();
  });

  it("a second close does not clean up twice", () => {
    const clearPainted = vi.fn();
    const { result } = setup(clearPainted);

    act(() => result.current.setPanel("search"));
    act(() => {
      result.current.close();
    });
    act(() => {
      result.current.close();
    });

    expect(clearPainted).toHaveBeenCalledTimes(1);
  });

  /**
   * `setPanel` is the raw move the "jump away" paths use: they close the
   * drawer without cleaning up, because the query and the painted matches are
   * still the reader's context if they come back.
   */
  it("setPanel leaves the query and the painted matches alone", () => {
    const clearPainted = vi.fn();
    const { result } = setup(clearPainted);

    act(() => result.current.setPanel("search"));
    act(() => result.current.setSearch("kittens"));
    act(() => result.current.setPanel("none"));

    expect(result.current.search).toBe("kittens");
    expect(clearPainted).not.toHaveBeenCalled();
  });

  /**
   * `close` goes into the reader's key handler dependency list, and a fresh
   * identity there re-registers the listener on every render.
   */
  it("close keeps its identity across renders", () => {
    const clear = vi.fn();
    const { result, rerender } = renderHook(
      ({ clearPainted }) => useReaderPanels("", clearPainted),
      { initialProps: { clearPainted: clear } },
    );
    const first = result.current.close;

    rerender({ clearPainted: clear });

    expect(result.current.close).toBe(first);
  });
});
