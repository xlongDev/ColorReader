/**
 * The one thing no shipping build carries: LXGW WenKai.
 *
 * The webfont package is 582 `@font-face` rules — 539 KB, the largest thing in
 * the first paint — pointing at 29 MB of subsets. Both builds that ship leave
 * them out (`vite.config.ts`): the GitHub Pages preview, which has no Rust
 * behind it, and the desktop app bundle, which would carry 29 MB for a family
 * that is the fifth option in a picker defaulting to 「系统」. Only `pnpm dev`
 * resolves this module — the face is served from `node_modules` there, loaded
 * lazily (see `loadBundledFontCss`), so this file is the other half of that
 * arrangement: the *decision* whether the face exists at all, which CSSOM can
 * no longer answer once the sheet is no longer there at startup.
 *
 * 🔴 Not a build flag read in two places — that is exactly how the two halves
 * drift. This module is aliased: the shipping builds resolve it to
 * `no-bundled-font.ts`, so the answer is decided in `vite.config.ts` beside
 * the alias that removes the rules in the first place.
 */

/**
 * Whether this build carries the bundled webfont at all.
 *
 * Dev: `true`, and the face is one stylesheet away. Anything that ships:
 * `false` — the GitHub Pages preview and the desktop app bundle both leave the
 * package out (`vite.config.ts`), and offering 霞鹜文楷 would fall through the
 * stack to the system 楷体 with no word — the same silent substitution that
 * used to happen when an imported font was deleted while it was selected. The
 * picker hides the option instead (`offeredFontStacks`), so there is no build
 * where the offer exists and the rules do not.
 */
export const BUNDLED_FONT_AVAILABLE = true;

/**
 * The built stylesheet, fetched and adopted — once.
 *
 * 🔴 A `<link>`, not `import("…/style.css")`. A CSS file is not a module: the
 * bundler emits a preload side-effect for it and the dynamic import *rejects*
 * with `Failed to fetch dynamically imported module`. That rejection is silent
 * where it matters — nothing throws, no request fails, and the reader who
 * picked 霞鹜文楷 watches the book render in 楷体 and never learns why. So the
 * URL is taken with `?url` (which makes the bundler treat the file as an asset
 * and emit its hashed name) and the stylesheet is adopted the way a browser
 * adopts any other one, which is also what puts its rules in the CSSOM where
 * `bundledFontFaces` looks for them.
 */
export async function loadBundledFontCss(): Promise<void> {
  const { default: href } = await import("lxgw-wenkai-webfont/style.css?url");
  await new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => reject(new Error(`霞鹜文楷样式表加载失败：${href}`)), {
      once: true,
    });
    document.head.append(link);
  });
}
