import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

/**
 * A clippings import, in the two steps the dialog walks: `preview` reports what
 * the file would do, `commit` does it.
 *
 * Both go through the same backend run, so the numbers on the confirm button
 * are the numbers the reader gets — and the shelf is only invalidated after a
 * commit, never after a look.
 */
/** A clippings run: a path from the desktop's picker, or the file itself in the
 *  browser. Two steps, one call — `dryRun` reports what it would write. */
const run = (dryRun: boolean) => (target: string | File) =>
  typeof target === "string"
    ? ipc.clippingsImport(target, dryRun)
    : ipc.clippingsImportFile(target, dryRun);

export function useClippings() {
  const queryClient = useQueryClient();

  const preview = useMutation({
    mutationFn: run(true),
  });

  const commit = useMutation({
    mutationFn: run(false),
    onSuccess: () => {
      // Highlights are per book and the reader may be open behind the dialog.
      void queryClient.invalidateQueries({ queryKey: ["annotations"] });
    },
  });

  return { preview, commit };
}
