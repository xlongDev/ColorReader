import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useTauriEvent } from "./useTauriEvent";

/**
 * Registration is a round trip, so the component can be gone before the
 * unsubscribe function arrives. These cases pin the two ends of that race:
 * the subscription has to be released either way, and never left dangling.
 */
describe("useTauriEvent", () => {
  it("releases the subscription when unmount beats registration", async () => {
    const unlisten = vi.fn();
    let release!: (fn: () => void) => void;
    const subscribe = vi.fn(() => new Promise<() => void>((resolve) => (release = resolve)));

    const { unmount } = renderHook(() => useTauriEvent(subscribe, () => {}));
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());

    unmount();
    release(unlisten);

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("releases the subscription on a plain unmount", async () => {
    const unlisten = vi.fn();
    const subscribe = vi.fn(async () => unlisten);

    const { unmount } = renderHook(() => useTauriEvent(subscribe, () => {}));
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("hands payloads to the newest handler without resubscribing", async () => {
    let emit: ((payload: string) => void) | undefined;
    const subscribe = vi.fn(async (handler: (payload: string) => void) => {
      emit = handler;
      return () => {};
    });

    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ onPayload }: { onPayload: (payload: string) => void }) =>
        useTauriEvent(subscribe, onPayload),
      { initialProps: { onPayload: (p: string) => seen.push(`first:${p}`) } },
    );
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit?.("a");

    rerender({ onPayload: (p: string) => seen.push(`second:${p}`) });
    emit?.("b");

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["first:a", "second:b"]);
  });
});
