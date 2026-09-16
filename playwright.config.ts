import { defineConfig } from "@playwright/test";

/**
 * The smoke suite runs in both engines on purpose.
 *
 * The app ships as a Tauri binary, which is WKWebView on macOS — so WebKit is
 * the engine that actually renders for a reader, and Chromium is only the
 * convenient one to develop against. The two disagree about more than they
 * look like they do: the same Chinese string measures about 15% wider in
 * WebKit, which is enough to take a row that "just fits" on one engine past
 * the edge on the other. A layout assertion that only ever ran on Chromium
 * would be checking the engine nobody uses.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "pnpm vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
