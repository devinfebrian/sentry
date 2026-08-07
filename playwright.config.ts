import { defineConfig, devices } from "@playwright/test";
import { loadTestEnv } from "./tests/env";

// Test credentials live in .env unprefixed, so the runner has to load them itself.
loadTestEnv();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [
    // A cold Vite start has to transform xlsx before the first paint, which can exceed
    // the 30s default and produce a spurious auth failure.
    { name: "setup", testMatch: /auth\.setup\.ts/, timeout: 120_000 },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
