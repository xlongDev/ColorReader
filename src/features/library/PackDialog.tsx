import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Lock, Package } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput, GlassSwitch } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import type { BookSummary } from "@/types/ipc";

interface ExportDialogProps {
  book: BookSummary | null;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Receives the path chosen by the native save dialog. */
  onConfirm: (request: { book: BookSummary; path: string; password?: string }) => void;
}

/**
 * Export one book as a book pack.
 *
 * The destination extension is what selects the format, so the switch and the
 * save dialog's filter are kept in lockstep: the file the user sees is the file
 * they get.
 */
export function ExportPackDialog({ book, busy, error, onCancel, onConfirm }: ExportDialogProps) {
  const [encrypted, setEncrypted] = useState(false);
  const [password, setPassword] = useState("");

  if (!book) return null;
  const extension = encrypted ? "ctzx" : "ctz";
  const ready = !encrypted || password.length > 0;

  const choose = async () => {
    try {
      const path = await save({
        title: "导出书档",
        defaultPath: `${book.title}.${extension}`,
        filters: [{ name: "书档", extensions: [extension] }],
      });
      if (path === null) return;
      onConfirm({ book, path, password: encrypted ? password : undefined });
    } catch {
      // No native dialog outside the shell; nothing to export to.
    }
  };

  return (
    <GlassDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={
        <span className="flex items-center gap-2">
          <Package size={16} weight="duotone" />
          导出《{book.title}》
        </span>
      }
      description="书档会带上原文件、阅读进度、收藏状态和全部标注。章节与封面不打包，导入时会从原文件重新提取。"
      widthClass="w-[min(92vw,440px)]"
    >
      <div className="space-y-3">
        <div className="border-hairline bg-surface-1 flex items-center justify-between rounded-md border px-3 py-2.5">
          <label htmlFor="pack-encrypt" className="flex cursor-pointer items-center gap-2">
            <Lock size={14} className="text-text-2" />
            <span className="text-text-1 text-sm">用密码加密（.ctzx）</span>
          </label>
          <GlassSwitch id="pack-encrypt" checked={encrypted} onCheckedChange={setEncrypted} />
        </div>

        {encrypted && (
          <div>
            <GlassInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="设置一个打开书档的密码"
              aria-label="书档密码"
            />
            <p className="text-text-3 mt-1.5 text-xs">
              密码不会存进书库，忘了就无法恢复书档里的原文件。
            </p>
          </div>
        )}

        {error && <p className="text-danger text-xs">{error}</p>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton variant="primary" disabled={busy || !ready} onClick={() => void choose()}>
          {busy ? "正在导出…" : "选择保存位置"}
        </GlassButton>
      </div>
    </GlassDialog>
  );
}

interface PasswordDialogProps {
  /** Files waiting to be imported; only used for the count in the copy. */
  count: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}

/** One password for the whole batch: a wrong one fails only its own file. */
export function PackPasswordDialog({
  count,
  busy,
  error,
  onCancel,
  onConfirm,
}: PasswordDialogProps) {
  const [password, setPassword] = useState("");

  return (
    <GlassDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={
        <span className="flex items-center gap-2">
          <Lock size={16} weight="duotone" />
          输入书档密码
        </span>
      }
      description={`这次导入的 ${count} 个文件里有加密书档，需要密码才能解开。`}
      widthClass="w-[min(92vw,400px)]"
    >
      <GlassInput
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && password) onConfirm(password);
        }}
        placeholder="书档密码"
        aria-label="书档密码"
      />
      {error && <p className="text-danger mt-2 text-xs">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton
          variant="primary"
          disabled={busy || password.length === 0}
          onClick={() => onConfirm(password)}
        >
          导入
        </GlassButton>
      </div>
    </GlassDialog>
  );
}
