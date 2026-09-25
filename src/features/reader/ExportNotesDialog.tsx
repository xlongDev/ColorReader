import { useState } from "react";
import { FileText, NotePencil, Table } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useSavePath } from "@/hooks/useSavePath";
import { isDesktopRuntime } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import { filename } from "@/lib/filename";

/** The two shapes the backend can write, and what each one is good for. */
const FORMATS = [
  {
    key: "md",
    label: "Markdown",
    hint: "按章节引用原文，笔记写在下面，适合放进笔记软件",
    icon: FileText,
  },
  {
    key: "csv",
    label: "CSV 表格",
    hint: "一行一条标注，带上原文、笔记和颜色，可用 Excel 打开",
    icon: Table,
  },
] as const;

type Format = (typeof FORMATS)[number]["key"];

interface ExportNotesDialogProps {
  /** What the dialog talks about: `《三体》` for one book, `这 3 本书` for a
   *  cross-book export. Kept as the caller's phrase rather than derived from a
   *  count, because only the caller knows what the set is. */
  subject: string;
  /** Stem for the suggested filename, before the extension. */
  name: string;
  /** How much there is to write, so the reader knows before choosing a path. */
  highlights: number;
  /** Of those, how many carry a note. */
  notes: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Receives the path chosen by the native save dialog. */
  /** `path` is `null` in the browser: there is no save panel and nowhere to
   *  write, so the file goes to a download under the name offered here. */
  onConfirm: (path: string | null, format: string) => void;
}

/**
 * Exports highlights and notes as a file anyone can read.
 *
 * The shape is picked here rather than by the save dialog's filter: switching
 * a native panel's format dropdown is not something a reader should have to
 * discover, and the extension the file lands with is the one they picked here.
 *
 * One book or several is the caller's business — it changes the sentence and
 * the suggested filename, not the dialog. The backend writes both through the
 * same per-highlight blocks.
 */
export function ExportNotesDialog({
  subject,
  name,
  highlights,
  notes,
  busy,
  error,
  onCancel,
  onConfirm,
}: ExportNotesDialogProps) {
  const [format, setFormat] = useState<Format>("md");
  const { choose: choosePath, error: panelError } = useSavePath();
  const empty = highlights === 0;

  /** The panel's own failure outranks the write's: it happens first. */
  const message = error ?? panelError;

  const choose = async () => {
    if (!isDesktopRuntime) {
      onConfirm(null, format);
      return;
    }
    const path = await choosePath({
      title: "导出标注与笔记",
      defaultPath: `${filename(name, "标注与笔记")}.${format}`,
      filters: [{ name: format === "md" ? "Markdown" : "CSV 表格", extensions: [format] }],
    });
    if (path === null) return;
    onConfirm(path, format);
  };

  return (
    <GlassDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={
        <span className="flex items-center gap-2">
          <NotePencil size={16} weight="duotone" />
          导出标注与笔记
        </span>
      }
      description={
        empty
          ? `${subject}还没有标注，先划一句再回来。`
          : `${subject}有 ${highlights} 条标注${notes > 0 ? `，其中 ${notes} 条写了笔记` : ""}。导出的文件不依赖这个应用，随时可以打开。`
      }
      widthClass="w-[min(92vw,440px)]"
    >
      <div className="space-y-2">
        {FORMATS.map(({ key, label, hint, icon: Icon }) => (
          <button
            key={key}
            type="button"
            aria-pressed={format === key}
            disabled={empty}
            onClick={() => setFormat(key)}
            className={cn(
              "press focus-visible:focus-ring flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left disabled:opacity-50",
              format === key ? "border-accent bg-surface-1" : "border-hairline hover:bg-surface-1",
            )}
          >
            <Icon size={16} weight="duotone" className="text-text-2 mt-0.5" />
            <span className="min-w-0">
              <span className="text-text-1 block text-sm">{label}</span>
              <span className="text-text-3 block text-xs leading-relaxed">{hint}</span>
            </span>
          </button>
        ))}

        {message && <p className="text-danger text-xs">{message}</p>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton variant="primary" disabled={busy || empty} onClick={() => void choose()}>
          {busy ? "正在导出…" : isDesktopRuntime ? "选择保存位置" : "导出"}
        </GlassButton>
      </div>
    </GlassDialog>
  );
}
