import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

/**
 * Moves a reader's marks onto a re-imported edition and drops the old one.
 *
 * The decision to do it is the reader's — see `editionTwins` for how a pair is
 * found and `MigrateEditionDialog` for the question they are asked. All this
 * hook owns is the call and what has to be re-read afterwards: the shelf (the
 * old row is gone), the annotations (they moved to another book id) and the
 * bookmarks.
 *
 * `onSuccess` rather than `onSettled`: a rejected migration changed nothing,
 * and refetching then would only re-render the shelf the reader was looking at.
 */
export function useMigrateEdition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => ipc.bookMigrate(from, to),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["books"] });
      void queryClient.invalidateQueries({ queryKey: ["annotations"] });
      void queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
    },
  });
}
