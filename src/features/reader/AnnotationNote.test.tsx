import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AnnotationNote } from "./AnnotationNote";

/** Renders the field for `note` and hands back its save spy. */
function setup(note: string | null = null) {
  const onSave = vi.fn();
  render(<AnnotationNote note={note} onSave={onSave} />);
  return onSave;
}

const field = () => screen.getByRole("textbox", { name: "标注笔记" });

describe("AnnotationNote", () => {
  it("shows a saved note and offers no add affordance", () => {
    setup("第三章埋了伏笔");
    expect(screen.getByRole("button", { name: "第三章埋了伏笔" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /添加笔记/ })).not.toBeInTheDocument();
  });

  it("opens a focused field from the add affordance", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /添加笔记/ }));
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue("");
  });

  it("saves a trimmed draft when the field loses focus", async () => {
    const user = userEvent.setup();
    const onSave = setup();
    await user.click(screen.getByRole("button", { name: /添加笔记/ }));
    await user.type(field(), "  伏笔在这里  ");
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("伏笔在这里");
  });

  it("saves on ⌘/Ctrl + Enter without waiting for a blur", async () => {
    const user = userEvent.setup();
    const onSave = setup();
    await user.click(screen.getByRole("button", { name: /添加笔记/ }));
    await user.type(field(), "记一笔");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSave).toHaveBeenCalledWith("记一笔");
  });

  it("closes without saving when the draft is unchanged", async () => {
    const user = userEvent.setup();
    const onSave = setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.click(document.body);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rewinds on Escape instead of saving", async () => {
    const user = userEvent.setup();
    const onSave = setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.type(field(), "改到一半");
    await user.keyboard("{Escape}");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "原笔记" })).toBeInTheDocument();
  });

  it("clears the note when the field is emptied", async () => {
    const user = userEvent.setup();
    const onSave = setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.clear(field());
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("treats a whitespace-only draft on a bare highlight as no change", async () => {
    const user = userEvent.setup();
    const onSave = setup();
    await user.click(screen.getByRole("button", { name: /添加笔记/ }));
    await user.type(field(), "   ");
    await user.click(document.body);
    expect(onSave).not.toHaveBeenCalled();
  });
});
