import { useState } from "react";
import { FileText, NotePencil, Table } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useSavePath } from "@/hooks/useSavePath";
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
  /** Title of the book; also seeds the suggested filename. */
  title: string;
  /** How much there is to write, so the reader knows before choosing a path. */
  highlights: number;
  /** Of those, how many carry a note. */
  notes: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Receives the path chosen by the native save dialog. */
  onConfirm: (path: string) => void;
}

/**
 * Exports one book's highlights and notes as a file anyone can read.
 *
 * The shape is picked here rather than by the save dialog's filter: switching
 * a native panel's format dropdown is not something a reader should have to
 * discover, and the extension the file lands with is the one they picked here.
 */
export function ExportNotesDialog({
  title,
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
    const path = await choosePath({
      title: "导出标注与笔记",
      defaultPath: `${filename(title, "标注与笔记")}.${format}`,
      filters: [{ name: format === "md" ? "Markdown" : "CSV 表格", extensions: [format] }],
    });
    if (path === null) return;
    onConfirm(path);
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
          ? `《${title}》还没有标注，先划一句再回来。`
          : `《${title}》有 ${highlights} 条标注${notes > 0 ? `，其中 ${notes} 条写了笔记` : ""}。导出的文件不依赖这个应用，随时可以打开。`
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
              "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
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
          {busy ? "正在导出…" : "选择保存位置"}
        </GlassButton>
      </div>
    </GlassDialog>
  );
}
