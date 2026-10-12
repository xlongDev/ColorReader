/**
 * The desktop app build: the normal frontend build, minus the bundled webfont.
 *
 * `vite.config.ts` leaves LXGW WenKai's 582 subsets — 29 MB of woff2, the
 * single largest thing in the app bundle — out of the bundle when
 * `CR_NO_BUNDLED_FONT` is set. Tauri's `beforeBuildCommand` runs this script,
 * so the `.app` / installer the reader gets ships neither the subsets nor the
 * face rules, and the font picker simply stops offering 霞鹜文楷 there
 * (`offeredFontStacks` reads `BUNDLED_FONT_AVAILABLE`) instead of silently
 * falling through to the system 楷体.
 *
 * A script rather than `CR_NO_BUNDLED_FONT=1 pnpm build` in
 * `tauri.conf.json`: the beforeBuildCommand runs through the platform shell,
 * and Windows `cmd` does not understand that prefix.
 *
 * What keeps the font: `pnpm dev` / `pnpm tauri dev` (served from
 * `node_modules`, no bundle emitted) and the GitHub Pages preview (which has
 * its own reason to drop it — see `vite.config.ts`).
 */
import { spawnSync } from "node:child_process";

process.env.CR_NO_BUNDLED_FONT = "1";

const result = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  // `npm` is a `.cmd` shim on Windows; without a shell it does not resolve.
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
