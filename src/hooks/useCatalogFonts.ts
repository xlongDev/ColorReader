import { useMutation } from "@tanstack/react-query";

import { downloadCatalogFont, removeCatalogFont } from "@/features/reader/catalogFont";
import { catalogKey, type CatalogFont } from "@/lib/fontCatalog";
import { useReaderSettings } from "@/stores/reader";
import { useSettings } from "@/stores/settings";

/**
 * Installs one catalogue font: its sheets are fetched, verified and adopted,
 * and the id joins the picker's offer.
 *
 * The flag is what makes the font selectable — the bytes are adopted either
 * way (`ensureCatalogAdopted` runs the same code on the reader path), so a
 * first selection before anyone presses 下载 in the settings costs nothing
 * extra.
 */
export function useDownloadCatalogFont() {
  const add = useSettings((state) => state.addDownloadedFont);
  return useMutation({
    mutationFn: (font: CatalogFont) => downloadCatalogFont(font),
    onSuccess: (_bytes, font) => add(font.id),
    meta: { silent: true },
  });
}

/**
 * Uninstalls one catalogue font — the sheet in the document, the copy kept for
 * the next launch, and the id in `downloadedFonts` — and steps the picker off
 * it when it is the one in use, for the same reason `useDeleteFont` does:
 * selecting a family whose sheet is no longer adopted would silently fall
 * through the stack.
 *
 * Returning to 原书 is the state a fresh install starts in, and one the reader
 * can see.
 */
export function useRemoveCatalogFont() {
  const remove = useSettings((state) => state.removeDownloadedFont);
  const selected = useReaderSettings((state) => state.fontFamily);
  const update = useReaderSettings((state) => state.update);
  return useMutation({
    mutationFn: async (font: CatalogFont) => {
      remove(font.id);
      removeCatalogFont(font.id);
    },
    onSuccess: (_result, font) => {
      if (selected === catalogKey(font.id)) update({ fontFamily: "book" });
    },
    meta: { silent: true },
  });
}
