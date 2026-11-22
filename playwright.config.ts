import { defineConfig } from "@playwright/test";

const chromium = process.env["PLAYWRIGHT_CHROMIUM_PATH"];

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  // Lets a machine with a Chromium already installed (for another Playwright version) skip `playwright install`.
  ...(chromium === undefined ? {} : { use: { launchOptions: { executablePath: chromium } } }),
});
