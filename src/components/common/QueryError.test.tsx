import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { QueryError } from "@/components/common/QueryError";

const ERROR = new Error("database is locked: /Users/x/Library/Application Support/colorreader.db");

describe("QueryError", () => {
  it("leads with a human sentence, not the exception", () => {
    render(<QueryError error={ERROR} description="书库这次没有读出来。" />);

    // The description is what a reader reads first; the raw message must not
    // leak into it the way `String(error)` once did.
    const description = screen.getByText(/书库这次没有读出来/);
    expect(description).toBeInTheDocument();
    expect(description).not.toHaveTextContent(ERROR.message);
  });

  it("wires the retry button to the caller's query", async () => {
    const onRetry = vi.fn();
    render(<QueryError error={ERROR} onRetry={onRetry} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("folds the exception away where a report can still quote it", () => {
    render(<QueryError error={ERROR} />);

    // Not deleted: the <details> is the one thing a bug report can copy. A
    // "fix" that drops this would take away the only actionable line on screen.
    const folded = screen.getByText("诊断信息").closest("details");
    expect(folded).not.toBeNull();
    expect(folded).toHaveTextContent(`${ERROR.name}: ${ERROR.message}`);
  });

  it("omits the retry button when there is no action to take", () => {
    render(<QueryError error={ERROR} />);

    // A diagnostic-only state (no onRetry) must not show a dead button.
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
