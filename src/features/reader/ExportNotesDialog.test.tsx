import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExportNotesDialog } from "./ExportNotesDialog";

// The native save dialog does not exist outside the shell; the test drives the
// same seam the component drives.
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));

// These cases are about what the panel is asked for and what happens when it is
// dismissed, and there is no panel in a browser: the dialog's other branch (a
// download, no question asked) is covered by the export's own round trip.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  isDesktopRuntime: true,
}));

// `restoreAllMocks` in the shared setup only covers `spyOn`, so the call log
// of a plain `vi.fn()` would otherwise carry over between cases.
beforeEach(() => {
  save.mockReset();
});

type Overrides = Partial<{
  subject: string;
  name: string;
  highlights: number;
  notes: number;
  busy: boolean;
  error: string | null;
}>;

function setup(overrides: Overrides = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ExportNotesDialog
      subject="《三体》"
      name="三体"
      highlights={3}
      notes={1}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

const pick = (name: string | RegExp) => screen.getByRole("button", { name });
const confirm = () => screen.getByRole("button", { name: "选择保存位置" });

describe("ExportNotesDialog", () => {
  it("suggests the book's title with the Markdown extension", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue("/tmp/notes.md");
    const { onConfirm } = setup();

    await user.click(confirm());

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      defaultPath: "三体.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    expect(onConfirm).toHaveBeenCalledWith("/tmp/notes.md", "md");
  });

  it("switches the extension when the CSV table is picked", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue("/tmp/notes.csv");
    setup();

    await user.click(pick(/CSV 表格/));
    await user.click(confirm());

    expect(save.mock.calls[0]![0]).toMatchObject({
      defaultPath: "三体.csv",
      filters: [{ name: "CSV 表格", extensions: ["csv"] }],
    });
  });

  it("keeps a title that would break a filename out of the path", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue(null);
    setup({ name: "三体/黑暗森林:2" });

    await user.click(confirm());

    expect(save.mock.calls[0]![0].defaultPath).toBe("三体_黑暗森林_2.md");
  });

  it("writes nothing when the reader cancels the save dialog", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue(null);
    const { onConfirm } = setup();

    await user.click(confirm());

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says why the save panel could not open instead of going quiet", async () => {
    const user = userEvent.setup();
    // What the shell rejects with when the dialog plugin is not allowed to
    // save: the failure that used to be swallowed and read as a dead button.
    save.mockRejectedValue("dialog.save not allowed");
    const { onConfirm } = setup();

    await user.click(confirm());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/无法打开保存对话框/)).toHaveTextContent("dialog.save not allowed");
  });

  it("clears the reason once the panel opens again", async () => {
    const user = userEvent.setup();
    save.mockRejectedValueOnce("dialog.save not allowed");
    const { onConfirm } = setup();

    await user.click(confirm());
    expect(screen.getByText(/无法打开保存对话框/)).toBeInTheDocument();

    save.mockResolvedValue("/tmp/notes.md");
    await user.click(confirm());

    expect(screen.queryByText(/无法打开保存对话框/)).toBeNull();
    expect(onConfirm).toHaveBeenCalledWith("/tmp/notes.md", "md");
  });

  it("counts what will be written, and refuses when there is nothing", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ highlights: 0, notes: 0 });

    expect(screen.getByText(/还没有标注/)).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    await user.click(pick(/CSV 表格/));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("reports an error from the write instead of closing", () => {
    setup({ error: "磁盘满了" });
    expect(screen.getByText("磁盘满了")).toBeInTheDocument();
  });
});
