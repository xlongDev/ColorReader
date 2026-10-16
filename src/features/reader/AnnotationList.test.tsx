import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AnnotationList } from "./AnnotationList";
import type { Annotation } from "@/types/ipc";

const HIGHLIGHTS: Annotation[] = [
  {
    id: "a1",
    bookId: "b1",
    chapterIdx: 0,
    startChar: 0,
    endChar: 2,
    text: "你好",
    cfi: null,
    color: "#ffd12e",
    style: null,
    note: null,
    createdAt: 0,
  },
  {
    id: "a2",
    bookId: "b1",
    chapterIdx: 2,
    startChar: 0,
    endChar: 2,
    text: "再见",
    cfi: null,
    color: null,
    style: null,
    note: null,
    createdAt: 0,
  },
];

function setup(withShare = true) {
  const onDelete = vi.fn();
  const onNote = vi.fn();
  const onExport = vi.fn();
  const onShare = vi.fn();
  render(
    <AnnotationList
      annotations={HIGHLIGHTS}
      busy={false}
      onDelete={onDelete}
      onNote={onNote}
      onExport={onExport}
      onShare={withShare ? onShare : undefined}
    />,
  );
  return { onDelete, onNote, onExport, onShare };
}

describe("AnnotationList", () => {
  it("hands the pressed row's own highlight to the share card", async () => {
    // The card redraws per highlight, and the row is where the reader picks
    // one: the callback must carry the whole annotation, not just its id.
    const user = userEvent.setup();
    const { onShare } = setup();

    await user.click(screen.getAllByRole("button", { name: "分享这一句" })[1]!);

    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledWith(HIGHLIGHTS[1]);
  });

  it("shares without touching the highlight's note or its row", async () => {
    // Share is the one action here that makes something new: it must not
    // look like an edit and must not open the note field.
    const user = userEvent.setup();
    const { onNote, onDelete } = setup();

    await user.click(screen.getAllByRole("button", { name: "分享这一句" })[0]!);

    expect(onNote).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("offers no share button when there is no card to open", () => {
    // The notes screen reuses this list without the card; a button that
    // leads nowhere is worse than no button.
    setup(false);
    expect(screen.queryByRole("button", { name: "分享这一句" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "删除标注" })).toHaveLength(2);
  });
});
