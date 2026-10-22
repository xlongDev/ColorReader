import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SourcePicker, sourcePickerOpen } from "@/features/source/SourcePicker";

const SOURCES = [
  { id: "a", name: "示例书源" },
  { id: "b", name: "另一个书源" },
];

/** The list leaves through `AnimatePresence`, so it is a frame behind the
 *  click that closed it — the same reason `MiniBar`'s test uses `find`. */
const folded = () => waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));

function open(value = "a") {
  const onChange = vi.fn();
  render(<SourcePicker sources={SOURCES} value={value} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

const trigger = () => screen.getByRole("combobox", { name: "选择书源" });
const options = () => screen.getAllByRole("option");

describe("SourcePicker — 书源选择", () => {
  it("names the current source and starts folded", () => {
    open();

    expect(trigger()).toHaveTextContent("示例书源");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("marks the current source in the list", async () => {
    const { user } = open();
    await user.click(trigger());

    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(options()).toHaveLength(2);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(options()[1]).toHaveAttribute("aria-selected", "false");
  });

  it("reports the picked source and folds away", async () => {
    const { onChange, user } = open();
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "另一个书源" }));

    expect(onChange).toHaveBeenCalledWith("b");
    await folded();
  });

  it("walks the list with the arrows and picks with Enter", async () => {
    const { onChange, user } = open();
    await user.click(trigger());

    // Opening puts the focus on the current source, so the arrows start there.
    expect(options()[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(options()[1]).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("b");
    await folded();
  });

  it("takes Escape for the list alone, and hands the focus back", async () => {
    const { user } = open();
    await user.click(trigger());
    expect(sourcePickerOpen(), "the dialog's escape guard reads this").toBe(true);

    await user.keyboard("{Escape}");

    await folded();
    expect(trigger()).toHaveFocus();
    // The guard must be released with the list: a later Escape in the dialog
    // is the dialog's own, and a stuck guard would swallow it.
    expect(sourcePickerOpen()).toBe(false);
  });

  it("states the fact when there is nothing to pick", () => {
    render(<SourcePicker sources={[]} value="" onChange={vi.fn()} />);

    expect(screen.getByText("还没有书源")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
