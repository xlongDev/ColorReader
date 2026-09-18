import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

/** pdf.js loads its openjpeg/jbig2 JS fallbacks from `${wasmUrl}<file>?import`,
 * and Vite's dev server refuses dynamic imports of files under `public/`
 * ("copied as-is, not imported from source"). Serve the directory raw before
 * import analysis kicks in; production static serving needs no help. */
function servePdfjsAssets(): Plugin {
  return {
    name: "serve-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = /^\/pdfjs\/([\w.-]+)$/.exec((req.url ?? "").split("?")[0] ?? "")?.[1];
        if (!name) return next();
        try {
          const body = readFileSync(
            fileURLToPath(new URL(`./public/pdfjs/${name}`, import.meta.url)),
          );
          res.setHeader(
            "Content-Type",
            name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
          );
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), servePdfjsAssets()],
  // GitHub Pages serves the web build under /<repo>/; the Tauri builds keep
  // the root base so bundled assets resolve the same way as always.
  base: process.env.PAGES_BASE ?? "/",
  css: {
    postcss: {
      plugins: [
        /**
         * `font-display: block` on every `@font-face` in the app document.
         *
         * The LXGW webfont package authors its 582 subsets with `swap`, which
         * is the right default for a page that can afford a fallback and the
         * wrong one here: a reader switching to 霞鹜文楷 watches the book render
         * in 楷体 — the next family in the stack — for as long as the subsets
         * take to arrive, then change under them. `block` spends that moment
         * showing nothing instead of the wrong face, and the subsets come out
         * of the app bundle, so the moment is short.
         *
         * Scoped to `@font-face` rather than to the file: the app declares no
         * other faces in CSS (imported ones are generated at runtime by
         * `fontFaceCss`), so this can only ever touch the bundled package. The
         * foliate sections need the same rewrite and get it in `theme.ts`,
         * where the rules are read back out of this sheet.
         */
        {
          postcssPlugin: "font-display-block",
          Declaration(decl) {
            if (decl.prop !== "font-display" || decl.value !== "swap") return;
            if (decl.parent?.type !== "atrule") return;
            if (decl.parent.name !== "font-face") return;
            decl.value = "block";
          },
        },
      ],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The bare specifier imports the vendored readest fork of foliate-js
      // (MIT) instead of the npm package, so the paginator carries readest's
      // background/page fixes. TS resolves the same specifiers through the
      // ambient declarations in src/types/foliate-js.d.ts.
      "foliate-js": fileURLToPath(new URL("./src/vendor/foliate-js", import.meta.url)),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envDir: "../",
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Vite 8 bundles Rolldown: `oxc` is the built-in minifier, `esbuild` would
    // need a separate install.
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    rolldownOptions: {
      output: {
        // Stable framework vendor gets its own long-lived chunk; it changes
        // only on dependency upgrades, so the browser cache keeps it.
        advancedChunks: {
          groups: [
            { name: "vendor-react", test: /node_modules\/(react|react-dom|scheduler)\// },
            {
              name: "vendor-router-query",
              test: /node_modules\/(react-router|react-router-dom|@tanstack\/react-query)\//,
            },
          ],
        },
      },
    },
  },
});
