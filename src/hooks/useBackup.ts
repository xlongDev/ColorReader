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
    mutationFn: (path: string) => ipc.backupExport(path),
    meta: { silent: true },
  });
}

/** Unpacks the archive; the library is only swapped in on the next start. */
export function useStageBackup() {
  return useMutation({
    mutationFn: (path: string) => ipc.backupStage(path),
    meta: { silent: true },
  });
}
