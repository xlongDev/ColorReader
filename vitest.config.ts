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
      // which is how `sectionFractions` came to be verified by reading alone.
      "foliate-js": fileURLToPath(new URL("./src/vendor/foliate-js", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    coverage: {
      // O5: make the blind spots visible. No thresholds on purpose — a hard
      // limit would reward writing tests for the number's sake, and the
      // report's job is to show which modules changed without one.
      provider: "v8",
      // text-summary is the compact table every run prints; json-summary is
      // what the CI step reads to build the pull-request summary.
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // The vendored foliate fork is someone else's code, and the setup
        // file is scaffolding: neither says anything about this app's tests.
        "src/vendor/**",
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
      ],
    },
  },
});
