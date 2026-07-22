// FILE: playwright.config.ts
// Purpose: Cross-platform Playwright configuration for real Electron desktop journeys.

import * as Path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: __dirname,
  testMatch: "desktop.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  globalSetup: Path.join(__dirname, "global-setup.ts"),
  outputDir: Path.resolve(__dirname, "../test-results"),
  reporter: [
    ["line"],
    ["html", { outputFolder: Path.resolve(__dirname, "../playwright-report"), open: "never" }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
