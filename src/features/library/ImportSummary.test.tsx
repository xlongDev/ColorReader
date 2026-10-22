import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImportSummary } from "@/features/library/ImportSummary";
import type { ImportOutcome } from "@/types/ipc";

const imported: ImportOutcome = { kind: "imported", path: "/books/a.epub", id: "a", title: "A" };
const another: ImportOutcome = { kind: "imported", path: "/books/b.epub", id: "b", title: "B" };
const failed: ImportOutcome = { kind: "failed", path: "/books/broken.epub", message: "文件损坏" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ImportSummary — 导入结果", () => {
  it("says its piece and goes when everything landed", () => {
    const onClose = vi.fn();
    render(<ImportSummary outcomes={[imported]} onClose={onClose} />);

    expect(screen.getByText("1 本已导入")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5_999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays while there is a file that did not make it", () => {
    const onClose = vi.fn();
    render(<ImportSummary outcomes={[imported, failed]} onClose={onClose} />);

    // A minute is a dozen lifetimes of the success timer: this one is not on
    // a timer at all, because the failure list is the reader's to act on.
    act(() => vi.advanceTimersByTime(60_000));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("broken.epub：文件损坏")).toBeInTheDocument();
  });

  it("gives a new batch its own full six seconds", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ImportSummary outcomes={[imported]} onClose={onClose} />);

    act(() => vi.advanceTimersByTime(5_000));
    rerender(<ImportSummary outcomes={[another]} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1_000));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
