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
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
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
