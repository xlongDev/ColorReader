import { useEffect, useState } from "react";

import { ensureCatalogAdopted, isCatalogAdopted } from "@/features/reader/catalogFont";
import { catalogFontById, catalogFontOfKey } from "@/lib/fontCatalog";

/**
 * The key to render with, once a lazily-adopted face's sheet has landed.
 *
 * A catalogue font's `@font-face` rules are not in the document until they have
 * been fetched from the CDN and adopted — they are not in the bundle, which is
 * the entire point of the catalogue. Everything that reads the rules
 * (`adoptedFacesFor`, and through it `useFoliateStyle`) walks the CSSOM, so
 * before the sheet arrives it would answer "this build has no such face" and
 * the section would render in the system face the stack falls through to —
 * 宋体 for Noto Serif SC — then change under the reader once the rules showed
 * up.
 *
 * So while the sheet is in flight this reports the family the stack falls
 * through to (the entry's `fallbackKey`) rather than `null`. That is the same
 * family the stack would have given anyway, so the frame renders in exactly the
 * glyphs it would have rendered in any case; the memo re-runs the moment the
 * rules are there. `null` would instead mean "use the book's own font" on a
 * foliate book, which is a different font entirely and would read as a jump
 * rather than as a face finishing loading.
 *
 * Any other key, and any key whose face is already adopted, answers unchanged
 * and synchronously — which is every other path through the reader.
 */
export function useAdoptedFontKey(fontKey: string): string {
  // `catalogFontOfKey` answers with the entry itself, so this is one object for
  // as long as the key is — which is what lets the effect below depend on it
  // without re-running on every render.
  const catalog = catalogFontOfKey(fontKey);
  const pending = catalog && !isCatalogAdopted(catalog.id) ? catalog : null;

  // 🔴 Not `useState(pending !== null)`. A state's initial value is read on the
  // *first* render only, and the first render is the one where the reader has
  // not picked the font yet — so the sheet would be marked loaded before it was
  // ever asked for, and the effect below would return on its own guard.
  // Nothing throws and nothing is logged: the reader picks the font and watches
  // the book render in the fallback. Deriving "which face is waiting" from the
  // key instead means "loaded" is a statement about the sheet, not about when
  // this hook happened to mount.
  const [loadedId, setLoadedId] = useState<string | null>(null);

  useEffect(() => {
    if (pending === null || loadedId === pending.id) return;
    let cancelled = false;
    void ensureCatalogAdopted(catalogFontById(pending.id)!)
      .then(() => {
        if (!cancelled) setLoadedId(pending.id);
      })
      // A sheet that will not arrive leaves the reader on the fallback family,
      // which is what the stack would have given them anyway — but it must not
      // be silent about it, and it must not retry on every keystroke either.
      .catch((err: unknown) => {
        console.warn(`${pending.name}的字体样式表未能加载，正文回退到字体栈里的下一款`, err);
        if (!cancelled) setLoadedId(pending.id);
      });
    return () => {
      cancelled = true;
    };
  }, [pending, loadedId]);

  if (pending === null || loadedId === pending.id) return fontKey;
  return pending.fallbackKey;
}
