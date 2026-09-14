import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle, FileText, Warning } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useClippings } from "@/hooks/useClippings";
import type { ClippingsOutcome } from "@/types/ipc";

/**
 * Kindle highlights, in.
 *
 * The file has to be found on disk, so the first step is a picker; the second
 * is the preview, which is the same run with the writes skipped. The reader
 * confirms against real numbers rather than a guess, and the third state is the
 * receipt for the run they just confirmed.
 *
 * Copy is deliberately blunt about the two ways an import comes up short —
 * books the shelf never got, and highlights whose text the book no longer
 * contains — because both are silent failures otherwise.
 */

interface ClippingsDialogProps {
  /** `false` keeps it closed. */
  open: boolean;
  onClose: () => void;
}

/** The file's base name, for the line that confirms what was picked. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function ClippingsDialog({ open: isOpen, onClose }: ClippingsDialogProps) {
  const { preview, commit } = useClippings();
  const [path, setPath] = useState("");
  const [done, setDone] = useState<ClippingsOutcome | null>(null);

  const close = () => {
    setPath("");
    setDone(null);
    preview.reset();
    commit.reset();
    onClose();
  };

  const pick = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Kindle 摘录", extensions: ["txt"] }],
    });
    if (typeof picked !== "string") return;
    setDone(null);
    // Both sides reset: a previous run's numbers must not sit next to a new
    // file's error, and a failed pick must not leave the old report on screen.
    commit.reset();
    preview.reset();
    setPath(picked);
    preview.mutate(picked);
  };

  const report = done ?? preview.data ?? null;
  const failure = done ? null : (preview.error ?? commit.error);
  const busy = preview.isPending || commit.isPending;

  return (
    <GlassDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="导入 Kindle 摘录"
      description="把 My Clippings.txt 里的高亮读完，落到书架里对应的书上。笔记和书签不会被导入。"
      widthClass="w-[min(92vw,560px)]"
    >
      {!path ? (
        <div className="flex flex-col items-start gap-3">
          <GlassButton variant="primary" size="md" onClick={() => void pick()}>
            <FileText size={15} /> 选择 My Clippings.txt
          </GlassButton>
          <p className="text-text-3 text-xs leading-relaxed">
            文件在 Kindle 磁盘的 documents 目录里。导入只按书名匹配书架，不会改动原来的书籍文件。
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="border-hairline bg-surface-1 flex items-center justify-between gap-3 rounded-2xl border px-3 py-2">
            <span className="text-text-2 min-w-0 truncate text-xs" title={path}>
              {baseName(path)}
            </span>
            <button
              type="button"
              className="text-text-3 hover:text-text-1 focus-visible:focus-ring shrink-0 rounded-lg px-2 py-1 text-xs transition-colors"
              onClick={() => void pick()}
            >
              换一个
            </button>
          </div>

          {busy && !report && <p className="text-text-2 text-sm">正在读取与匹配…</p>}

          {failure && (
            <p className="text-danger flex items-start gap-2 text-sm">
              <Warning size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{String(failure)}</span>
            </p>
          )}

          {report && (
            <>
              <div className="grid grid-cols-4 gap-2">
                <Number label="高亮条目" value={report.total} />
                <Number label="命中书籍" value={report.books.length} />
                <Number label="可定位" value={report.located} />
                <Number label="已存在" value={report.duplicates} />
              </div>

              {done ? (
                <p className="text-text-1 flex items-center gap-2 text-sm">
                  <CheckCircle size={15} weight="fill" className="text-accent shrink-0" />
                  已导入 {done.imported} 条高亮。
                </p>
              ) : (
                <p className="text-text-2 text-xs">
                  确认后会新增 {report.imported} 条高亮，已经导入过的不会重复。
                </p>
              )}

              {(report.notes > 0 || report.bookmarks > 0) && (
                <p className="text-text-3 text-xs">
                  跳过 {report.notes} 条笔记、{report.bookmarks} 个书签。
                </p>
              )}

              {report.books.length > 0 && (
                <ul className="border-hairline divide-hairline max-h-52 divide-y overflow-y-auto rounded-2xl border">
                  {report.books.map((book) => (
                    <li
                      key={book.bookId}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="text-text-1 min-w-0 truncate text-[13px]">{book.title}</span>
                      <span className="text-text-3 shrink-0 text-xs tabular-nums">
                        {book.imported} 条{book.duplicates > 0 && ` · 已有 ${book.duplicates}`}
                        {book.unlocated > 0 && ` · ${book.unlocated} 条未找到`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {report.unknownTitles.length > 0 && (
                <div className="text-xs leading-relaxed">
                  <p className="text-text-2">书架里没有这些书，它们的摘录被跳过了：</p>
                  <p className="text-text-3 mt-1">
                    {report.unknownTitles.join("、")}
                    {report.matched < report.total && " 等"}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={close} disabled={busy}>
          {done ? "关闭" : "取消"}
        </GlassButton>
        {path && !done && (
          <GlassButton
            variant="primary"
            onClick={() => commit.mutate(path, { onSuccess: (outcome) => setDone(outcome) })}
            disabled={busy || !report || report.imported === 0}
          >
            {busy ? "正在导入…" : `导入 ${report?.imported ?? 0} 条`}
          </GlassButton>
        )}
      </div>
    </GlassDialog>
  );
}

/** One figure in the report grid. */
function Number({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-hairline bg-surface-1 rounded-2xl border px-3 py-2">
      <p className="text-text-1 text-lg leading-tight font-semibold tabular-nums">{value}</p>
      <p className="text-text-3 mt-0.5 text-[11px]">{label}</p>
    </div>
  );
}
