import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Same alias as `vite.config.ts`: the vendored readest fork, not the npm
      // package. Without it a test that reaches for foliate's own modules fails
      // to resolve, and the contract those modules owe this app goes unpinned —
      // which is how `sectionSpan` came to be verified by reading alone.
      "foliate-js": fileURLToPath(new URL("./src/vendor/foliate-js", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
