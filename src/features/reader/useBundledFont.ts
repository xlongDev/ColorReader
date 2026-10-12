import { useEffect, useState } from "react";

import { BUNDLED_FONT_AVAILABLE, loadBundledFontCss } from "@/features/reader/bundledFont";

/** The one key whose faces ship with the app rather than being imported. */
const BUNDLED_KEY = "lxgw";

/** 楷体 — the family 霞鹜文楷's own stack falls through to. */
const FALLBACK_KEY = "kai";

/**
 * The key to render with, once the bundled sheet has landed.
 *
 * 霞鹜文楷's `@font-face` rules are not in the document until this hook has
 * fetched them — 539 KB, too much to carry in the first paint for a family that
 * is the fifth option in a picker defaulting to 「系统」. Everything that reads
 * the rules (`bundledFacesFor`, and through it `useFoliateStyle`) walks the
 * CSSOM, so before the sheet arrives it would answer "this build has no such
 * face" and the section would render in the system 楷体, then change under the
 * reader once the rules showed up.
 *
 * So while the sheet is in flight this reports `kai` — 楷体 — rather than
 * `null`. That is the same family the 霞鹜文楷 stack falls through to, so the
 * frame renders in exactly the glyphs it would have rendered in anyway; the
 * memo re-runs the moment the rules are there. `null` would instead mean "use
 * the book's own font" on a foliate book, which is a different font entirely
 * and would read as a jump rather than as a face finishing loading.
 *
 * Any other key, and any key at all in a build without the webfont, answers
 * unchanged and synchronously — which is every other path through the reader.
 */
export function useBundledFont(fontKey: string): string {
  const wanted = fontKey === BUNDLED_KEY && BUNDLED_FONT_AVAILABLE;
  // 🔴 Not `useState(!wanted)`. A state's initial value is read on the *first*
  // render only, and the first render is the one where the reader has not
  // picked 霞鹜文楷 yet — so the sheet would be marked loaded before it was ever
  // asked for, and the effect below would return on its own guard. Nothing
  // throws and nothing is logged: the reader picks the font and watches the book
  // render in 楷体. Deriving it instead means "loaded" is a statement about the
  // sheet, not about when this hook happened to mount.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!wanted || loaded) return;
    let cancelled = false;
    void loadBundledFontCss()
      .then(() => {
        if (!cancelled) setLoaded(true);
      })
      // A sheet that will not arrive leaves the reader on the fallback family,
      // which is what the stack would have given them anyway — but it must not
      // be silent about it, and it must not retry on every keystroke either.
      .catch((err: unknown) => {
        console.warn("霞鹜文楷样式表未能加载，正文回退到系统楷体", err);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, loaded]);

  return wanted && !loaded ? FALLBACK_KEY : fontKey;
}
