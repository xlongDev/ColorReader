import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import { useReaderSettings } from "@/stores/reader";
import { archiveRequest, type CatalogFontFile } from "@/lib/fontCatalog";
import { customFontKey } from "@/features/reader/theme";
import type { LocalFont } from "@/types/ipc";

/** The fonts the reader imported. */
export function useFonts() {
  return useQuery<LocalFont[]>({
    queryKey: ["fonts"],
    queryFn: () => ipc.fontList(),
    staleTime: 30_000,
  });
}

/**
 * Copies one font in.
 *
 * A path on the desktop (its dialog hands one over) and the `File` itself in
 * the browser (there are no paths there). Everything past that point — the
 * bytes, the URL the face is declared from, the list it joins — is the same.
 */
export function useImportFont() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source: string | File) =>
      typeof source === "string" ? ipc.fontImport(source) : ipc.fontImportFile(source),
    meta: { silent: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fonts"] });
    },
  });
}

/**
 * Forgets one font — and steps the picker off it when it was the one in use.
 *
 * Deleting the selected font would otherwise leave the reading surface asking
 * for a family that no longer has an `@font-face` anywhere, so the text would
 * quietly render in whatever the browser falls back to, with nothing on screen
 * to explain it. Returning to the system stack is the same state a fresh
 * install starts in, and it is one the reader can see.
 */
export function useDeleteFont() {
  const queryClient = useQueryClient();
  const selected = useReaderSettings((s) => s.fontFamily);
  const update = useReaderSettings((s) => s.update);
  return useMutation({
    mutationFn: (id: string) => ipc.fontDelete(id),
    onSuccess: (_deleted, id) => {
      if (selected === customFontKey(id)) update({ fontFamily: "system" });
      void queryClient.invalidateQueries({ queryKey: ["fonts"] });
    },
  });
}

/**
 * Installs a catalogue face that arrives as a whole file.
 *
 * The whole journey — a 50 MB download, one member unpacked, the sha256 checked,
 * the face written beside the vendor's own licence — happens in Rust, because
 * that is the only side with a zip reader and a filesystem. What comes back is
 * an ordinary `LocalFont`, which is the point: once installed it is a font the
 * reader imported, offered by the same picker and removed by the same button.
 *
 * The list has to be refetched rather than patched: the settings row decides
 * between 下载 and 删除 by looking for a row carrying this entry's id, so a
 * stale list would leave a font installed with no way to take it out.
 */
export function useInstallCatalogFont() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (font: CatalogFontFile) => ipc.fontInstallCatalog(archiveRequest(font)),
    meta: { silent: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fonts"] });
    },
  });
}
