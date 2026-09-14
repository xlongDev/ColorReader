import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Annotation } from "@/types/ipc";

import { SelectionToolbar } from "./SelectionToolbar";

/** The highlight a tapped pill edits; `note` is what the field pre-fills from. */
function highlight(note: string | null = null): Annotation {
  return {
    id: "a1",
    bookId: "b1",
    chapterIdx: 2,
    startChar: 10,
    endChar: 20,
    text: "被划中的那一段",
    cfi: null,
    color: "#ffd12e",
    style: "underline",
    note,
    createdAt: 0,
  };
}

/** Renders the toolbar and hands back the note spy. */
function setup(annotation: Annotation | null = null) {
  const onNote = vi.fn();
  const onHighlight = vi.fn();
  render(
    <SelectionToolbar
      x={400}
      y={400}
      annotation={annotation}
      defaultColor="#ffd12e"
      defaultStyle="highlight"
      onCopy={vi.fn()}
      onSearch={vi.fn()}
      onSpeak={vi.fn()}
      onAsk={vi.fn()}
      onLookup={vi.fn()}
      onHighlight={onHighlight}
      onRestyle={vi.fn()}
      onNote={onNote}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { onNote };
}

const field = () => screen.getByRole("textbox", { name: "笔记" });
const openField = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "记笔记" }));

describe("SelectionToolbar note field", () => {
  it("stays closed until asked for", () => {
    setup();
    expect(screen.queryByRole("textbox", { name: "笔记" })).not.toBeInTheDocument();
  });

  it("opens an empty focused field on a bare selection", async () => {
    const user = userEvent.setup();
    setup();
    await openField(user);
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue("");
  });

  it("saves the trimmed draft once focus leaves the toolbar", async () => {
    const user = userEvent.setup();
    const { onNote } = setup();
    await openField(user);
    await user.type(field(), "  伏笔在这里  ");
    await user.click(document.body);
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onNote).toHaveBeenCalledWith("伏笔在这里");
  });

  it("leaves the draft alone while focus stays inside the toolbar", async () => {
    const user = userEvent.setup();
    const { onNote } = setup();
    await openField(user);
    await user.type(field(), "还没写完");
    await user.click(screen.getByRole("button", { name: "红色" }));
    expect(onNote).not.toHaveBeenCalled();
  });

  it("rewinds on Escape instead of saving", async () => {
    const user = userEvent.setup();
    const { onNote } = setup();
    await openField(user);
    await user.type(field(), "改到一半");
    await user.keyboard("{Escape}");
    expect(onNote).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "笔记" })).not.toBeInTheDocument();
  });

  it("pre-fills the highlight's own note", async () => {
    const user = userEvent.setup();
    setup(highlight("第三章埋了伏笔"));
    await openField(user);
    expect(field()).toHaveValue("第三章埋了伏笔");
  });

  it("does not write an unchanged draft back", async () => {
    const user = userEvent.setup();
    const { onNote } = setup(highlight("第三章埋了伏笔"));
    await openField(user);
    await user.click(document.body);
    expect(onNote).not.toHaveBeenCalled();
  });

  it("clears the note when the field is emptied", async () => {
    const user = userEvent.setup();
    const { onNote } = setup(highlight("第三章埋了伏笔"));
    await openField(user);
    await user.clear(field());
    await user.click(document.body);
    expect(onNote).toHaveBeenCalledWith(null);
  });

  it("creates nothing when a bare selection's field is left empty", async () => {
    const user = userEvent.setup();
    const { onNote } = setup();
    await openField(user);
    await user.type(field(), "   ");
    await user.click(document.body);
    expect(onNote).not.toHaveBeenCalled();
  });

  it("saves the note when the panel is closed by its own button", async () => {
    const user = userEvent.setup();
    const { onNote } = setup();
    await openField(user);
    await user.type(field(), "收工");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onNote).toHaveBeenCalledWith("收工");
  });
});
