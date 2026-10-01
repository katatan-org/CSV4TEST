import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e-results",
  timeout: 30_000,
  // All tests share the origin-private file system, so they must not run in parallel.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:5179",
    channel: "chrome",
    viewport: { width: 1600, height: 900 },
  },
  webServer: {
    command: "npx vite --port 5179 --strictPort",
    url: "http://localhost:5179",
    reuseExistingServer: true,
  },
});
