import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ShelfGrid } from "@/features/library/ShelfGrid";

/**
 * The shelf's failed read.
 *
 * The contract is a division of labour, and it is easy to get wrong in both
 * directions. The raw rejection used to *be* the description — a database lock
 * or a missing file, in English, under a heading that says 书架暂时打不开 — so
 * the sentence and the one useful action are what this pins. But a "fix" that
 * drops the exception entirely would take away the only thing a report can
 * quote, so it is pinned too: folded away, not deleted.
 */

type Props = Parameters<typeof ShelfGrid>[0];

const ERROR = new Error("database is locked: /Users/x/Library/Application Support/colorreader.db");

/** What the window hook returns; the error branch returns before anything
 *  reads it, so an empty window is honest rather than a convenient lie. */
const NO_WINDOW: Props["shelf"] = {
  items: [],
  start: 0,
  end: 0,
  top: 0,
  bottom: 0,
  columns: 1,
  sliding: false,
};

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    pending: false,
    error: ERROR,
    search: "",
    list: [],
    shelf: NO_WINDOW,
    gridRef: { current: null },
    layout: "grid",
    tagRow: false,
    collapsed: new Set<string>(),
    onToggleSection: vi.fn(),
    managing: false,
    selected: new Set<string>(),
    busy: false,
    onToggleSelect: vi.fn(),
    onOpen: vi.fn(),
    onToggleFavorite: vi.fn(),
    onAskDelete: vi.fn(),
    onAskExport: vi.fn(),
    onExportFile: vi.fn(),
    onEditTags: vi.fn(),
    onEditMeta: vi.fn(),
    onImport: vi.fn(),
    onClearSearch: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  render(<ShelfGrid {...props} />);
  return props;
}

describe("ShelfGrid's error state", () => {
  it("says what happened in a sentence, not in the exception", () => {
    setup();

    // The heading is unchanged; what changed is what sits under it. Matching on
    // the opening words is the assertion: `String(error)` as the description
    // would leave nothing for this to find.
    const description = screen.getByText(/^书库这次没有读出来/);
    expect(description).toBeInTheDocument();
    expect(description).not.toHaveTextContent(ERROR.message);
  });

  it("offers the one action that can help, wired to the shelf's own query", async () => {
    const { onRetry } = setup();

    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the exception, folded away where a report can still quote it", () => {
    setup();

    // Not deleted: the summary is the whole point of the `<details>` — a reader
    // who wants to report this has to be able to read it, and a reader who does
    // not is not made to.
    const folded = screen.getByText("诊断信息").closest("details");
    expect(folded).not.toBeNull();
    expect(folded).toHaveTextContent(`${ERROR.name}: ${ERROR.message}`);
  });

  it("keeps a thrown string readable too", () => {
    setup({ error: "书架索引损坏" });

    // `describeError` is what makes an unknown `throw` safe to show; a string
    // has no `.name`, and rendering `String(error)` would have lost the label
    // that says it is an error at all.
    const folded = screen.getByText("诊断信息").closest("details");
    expect(folded).toHaveTextContent("Error: 书架索引损坏");
  });
});
