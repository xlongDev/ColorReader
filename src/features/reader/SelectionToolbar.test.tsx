import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Annotation } from "@/types/ipc";

import { SelectionOverlay, SelectionToolbar } from "./SelectionToolbar";

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

/** The props a fresh selection hands the toolbar. */
function toolbarProps(annotation: Annotation | null, onNote = vi.fn(), onHighlight = vi.fn()) {
  return {
    x: 400,
    y: 400,
    annotation,
    defaultColor: "#ffd12e",
    defaultStyle: "highlight" as const,
    onCopy: vi.fn(),
    onSearch: vi.fn(),
    onSpeak: vi.fn(),
    onAsk: vi.fn(),
    onLookup: vi.fn(),
    onHighlight,
    onRestyle: vi.fn(),
    onNote,
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };
}

/** Renders the toolbar and hands back the note spy. */
function setup(annotation: Annotation | null = null) {
  const onNote = vi.fn();
  const onHighlight = vi.fn();
  render(<SelectionToolbar {...toolbarProps(annotation, onNote, onHighlight)} />);
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

/**
 * The three buttons under the field. Each one exists because the field
 * previously had no way to finish: a note was only written by clicking away,
 * and there was nothing for emptying or dropping one.
 */
describe("SelectionToolbar note actions", () => {
  it("keeps the action strip with the field it belongs to", async () => {
    const user = userEvent.setup();
    setup(highlight("已有的笔记"));
    expect(screen.queryByRole("button", { name: "保存笔记" })).not.toBeInTheDocument();
    await openField(user);
    expect(screen.getByRole("button", { name: "保存笔记" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空输入" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除笔记" })).toBeInTheDocument();
  });

  it("writes the draft on 保存 without waiting for focus to leave", async () => {
    const user = userEvent.setup();
    const { onNote } = setup();
    await openField(user);
    await user.type(field(), "先记下来");
    await user.click(screen.getByRole("button", { name: "保存笔记" }));
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onNote).toHaveBeenCalledWith("先记下来");
    // The field closes because the draft went back to `null`, which is the
    // same state blur leaves behind — not because a button tore it down.
    expect(screen.queryByRole("textbox", { name: "笔记" })).not.toBeInTheDocument();
  });

  it("refuses 保存 while the field still says what is saved", async () => {
    const user = userEvent.setup();
    const { onNote } = setup(highlight("第三章埋了伏笔"));
    await openField(user);
    expect(screen.getByRole("button", { name: "保存笔记" })).toBeDisabled();
    await user.type(field(), "，补一句");
    expect(screen.getByRole("button", { name: "保存笔记" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "保存笔记" }));
    expect(onNote).toHaveBeenCalledTimes(1);
    // Whatever the caret did, the write carries both the pre-filled note and
    // what was typed onto it — 保存 is not a "replace with the field" button.
    const written = onNote.mock.calls[0]?.[0] as string;
    expect(written).toContain("第三章埋了伏笔");
    expect(written).toContain("补一句");
  });

  it("empties the field on 清空 and writes nothing yet", async () => {
    const user = userEvent.setup();
    const { onNote } = setup(highlight("第三章埋了伏笔"));
    await openField(user);
    await user.click(screen.getByRole("button", { name: "清空输入" }));
    expect(field()).toHaveValue("");
    // Only the field: the saved note is still there until 保存 or leaving.
    expect(onNote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "清空输入" })).toBeDisabled();
  });

  it("drops the saved note on 删除 and leaves the highlight standing", async () => {
    const user = userEvent.setup();
    const { onNote } = setup(highlight("第三章埋了伏笔"));
    await openField(user);
    await user.click(screen.getByRole("button", { name: "删除笔记" }));
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onNote).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("textbox", { name: "笔记" })).not.toBeInTheDocument();
  });

  it("hides 删除 when there is no note to drop", async () => {
    const user = userEvent.setup();
    setup(highlight(null));
    await openField(user);
    expect(screen.queryByRole("button", { name: "删除笔记" })).not.toBeInTheDocument();
  });
});

describe("SelectionOverlay", () => {
  it("portals the toolbar into the shell's overlay host", () => {
    // The reading pane carries a `backdrop-filter` for the glass, which makes
    // it the containing block for `position: fixed` descendants — and it has
    // `overflow: hidden` too. Rendered in place, the toolbar was measured from
    // the pane's own origin and sliced at the page's right edge; the host is
    // the shell's, where `fixed` means the window again.
    const host = document.createElement("div");
    host.setAttribute("data-overlay-host", "");
    document.body.append(host);

    render(<SelectionOverlay toolbar={toolbarProps(null)} lookup={null} onLookupClose={vi.fn()} />);

    const toolbar = document.querySelector("[data-toolbar-rev]");
    expect(toolbar).not.toBeNull();
    expect(host.contains(toolbar)).toBe(true);

    host.remove();
  });

  it("renders nothing while there is no selection and no lookup", () => {
    render(<SelectionOverlay toolbar={null} lookup={null} onLookupClose={vi.fn()} />);
    expect(document.querySelector("[data-toolbar-rev]")).toBeNull();
  });
});
