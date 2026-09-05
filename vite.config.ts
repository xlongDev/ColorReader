import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
