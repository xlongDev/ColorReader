/** Stands in for `bundledFont.ts` in the web build only — see `vite.config.ts`.
 *
 *  The desktop's twin ships LXGW WenKai; this one says it does not exist, and
 *  loading it is a no-op. The web build already swaps the webfont's stylesheet
 *  for an empty sheet, so between the two answers there is no build where the
 *  picker offers a face whose rules are missing. */

export const BUNDLED_FONT_AVAILABLE = false;

export async function loadBundledFontCss(): Promise<void> {}
