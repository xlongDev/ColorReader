import { beforeEach, describe, expect, it, vi } from "vitest";

import { useToasts } from "./toasts";

describe("useToasts", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it("keeps one copy of a message that keeps arriving", () => {
    useToasts.getState().push({ tone: "error", message: "保存失败" });
    useToasts.getState().push({ tone: "error", message: "保存失败" });

    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("clears a toast once its timer runs out", () => {
    vi.useFakeTimers();
    try {
      useToasts.getState().push({ tone: "success", message: "已保存" });
      expect(useToasts.getState().toasts).toHaveLength(1);

      vi.runAllTimers();
      expect(useToasts.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
