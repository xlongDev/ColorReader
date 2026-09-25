import { useMutation } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

/**
 * Whole-library backup and restore.
 *
 * Both name their own result on the settings row, so both opt out of the
 * global write-failure toast — that one would say the same thing twice.
 */
export function useExportBackup() {
  return useMutation({
    // A path from the desktop's save panel, or `null` in the browser, whose
    // archive is its own and goes straight to a download.
    mutationFn: (target: string | null) =>
      target === null ? ipc.backupSave() : ipc.backupExport(target),
    meta: { silent: true },
  });
}

/** Unpacks the archive; on the desktop the library is only swapped in on the
 *  next start, while the browser's own stores are written back at once. */
export function useStageBackup() {
  return useMutation({
    mutationFn: (target: string | File) =>
      typeof target === "string" ? ipc.backupStage(target) : ipc.backupLoad(target),
    meta: { silent: true },
  });
}
