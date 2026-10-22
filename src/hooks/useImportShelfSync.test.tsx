import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as Ipc from "@/lib/ipc";

// The subscription *is* the hook's contract: capture what `useTauriEvent` is
// handed and drive it by hand, the way a real backend event would.
const captured = vi.hoisted(() => ({
  handler: null as null | ((progress: { done: number; total: number; path: string }) => void),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof Ipc>("@/lib/ipc");
  return {
    ...actual,
    onImportProgress: (
      subscribe: (progress: { done: number; total: number; path: string }) => void,
    ) => {
      captured.handler = subscribe;
      return Promise.resolve(undefined);
    },
  };
});

import { useImportShelfSync } from "@/hooks/useLibrary";

function Probe() {
  useImportShelfSync();
  return null;
}

const event = (done: number, total: number) => ({ done, total, path: `book-${done}` });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useImportShelfSync — 导入时的书架同步", () => {
  it("refetches the shelf once per quiet stretch, never once per book", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => captured.handler?.(event(1, 3)));
    act(() => captured.handler?.(event(2, 3)));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(400));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["books"] });
  });

  it("leaves the last book of a batch unstranded", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => captured.handler?.(event(1, 2)));
    act(() => vi.advanceTimersByTime(400));
    expect(invalidate).toHaveBeenCalledTimes(1);

    // A book that lands after the refetch still gets one of its own — the
    // call trails the window rather than leading it.
    act(() => captured.handler?.(event(2, 2)));
    act(() => vi.advanceTimersByTime(400));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
