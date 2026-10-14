import { useEffect, useState } from "react";

import { BUNDLED_FONT_AVAILABLE, loadBundledFontCss } from "@/features/reader/bundledFont";
import { ensureCatalogAdopted, isCatalogAdopted } from "@/features/reader/catalogFont";
import { catalogFontById, catalogFontOfKey } from "@/lib/fontCatalog";

/** The one key whose faces ship with the app rather than being imported. */
const BUNDLED_KEY = "lxgw";

/** 楷体 — the family 霞鹜文楷's own stack falls through to. */
const FALLBACK_KEY = "kai";

/**
 * The key to render with, once a lazily-adopted face's sheet has landed.
 *
 * Two kinds of face are adopted on demand rather than shipped in the first
 * paint:
 *
 * 霞鹜文楷 in `pnpm dev`, whose `@font-face` rules are not in the document
 * until this hook has fetched them — 539 KB, too much to carry in the first
 * paint for a family that is the fifth option in a picker defaulting to
 * 「系统」. Everything that reads the rules (`bundledFacesFor`, and through it
 * `useFoliateStyle`) walks the CSSOM, so before the sheet arrives it would
 * answer "this build has no such face" and the section would render in the
 * system 楷体, then change under the reader once the rules showed up.
 *
 * And every catalogue font the reader has downloaded (`catalog:<id>`), whose
 * sheets live on a CDN until adopted. Same problem, same answer: adopt first,
 * then render with the key.
 *
 * So while the sheet is in flight this reports the family the stack falls
 * through to — 楷体 for 霞鹜文楷, the catalogue entry's own `fallbackKey`
 * otherwise — rather than `null`. That is the same family the stack would
 * have given anyway, so the frame renders in exactly the glyphs it would have
 * rendered in any case; the memo re-runs the moment the rules are there.
 * `null` would instead mean "use the book's own font" on a foliate book,
 * which is a different font entirely and would read as a jump rather than as
 * a face finishing loading.
 *
 * Any other key, and any key at all whose face is already adopted, answers
 * unchanged and synchronously — which is every other path through the reader.
 */
export function useBundledFont(fontKey: string): string {
  const catalog = catalogFontOfKey(fontKey);
  const lazyId =
    fontKey === BUNDLED_KEY && BUNDLED_FONT_AVAILABLE
      ? BUNDLED_KEY
      : catalog && !isCatalogAdopted(catalog.id)
        ? catalog.id
        : null;

  // 🔴 Not `useState(lazyId !== null)`. A state's initial value is read on the
  // *first* render only, and the first render is the one where the reader has
  // not picked the font yet — so the sheet would be marked loaded before it
  // was ever asked for, and the effect below would return on its own guard.
  // Nothing throws and nothing is logged: the reader picks the font and
  // watches the book render in the fallback. Deriving "which face is waiting"
  // from the key instead means "loaded" is a statement about the sheet, not
  // about when this hook happened to mount.
  const [loadedId, setLoadedId] = useState<string | null>(null);

  useEffect(() => {
    if (lazyId === null || loadedId === lazyId) return;
    let cancelled = false;
    const load =
      lazyId === BUNDLED_KEY
        ? loadBundledFontCss
        : () => ensureCatalogAdopted(catalogFontById(lazyId)!);
    const label = lazyId === BUNDLED_KEY ? "霞鹜文楷" : (catalog?.name ?? fontKey);
    void load()
      .then(() => {
        if (!cancelled) setLoadedId(lazyId);
      })
      // A sheet that will not arrive leaves the reader on the fallback family,
      // which is what the stack would have given them anyway — but it must not
      // be silent about it, and it must not retry on every keystroke either.
      .catch((err: unknown) => {
        console.warn(`${label}的字体样式表未能加载，正文回退到字体栈里的下一款`, err);
        if (!cancelled) setLoadedId(lazyId);
      });
    return () => {
      cancelled = true;
    };
  }, [lazyId, loadedId, fontKey, catalog]);

  if (lazyId === null || loadedId === lazyId) return fontKey;
  return lazyId === BUNDLED_KEY ? FALLBACK_KEY : (catalog?.fallbackKey ?? FALLBACK_KEY);
}
