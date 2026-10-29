import { defineConfig, devices } from "@playwright/test";
const CI_EXPECT_TIMEOUT_IN_MS = 15000;
const LOCAL_EXPECT_TIMEOUT_IN_MS = 5000;

export default defineConfig({
  testDir: "./e2e",
  timeout: 45000,
  fullyParallel: true,
  // A cold CI runner can take a few seconds to serve a page's first module.
  expect: {
    timeout:
      process.env.CI !== undefined && process.env.CI !== ""
        ? CI_EXPECT_TIMEOUT_IN_MS
        : LOCAL_EXPECT_TIMEOUT_IN_MS,
  },
  forbidOnly: (process.env.CI == null || process.env.CI === "") === false,
  retries: process.env.CI !== undefined && process.env.CI !== "" ? 1 : 0,
  workers: 3,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5176",
    locale: "pt-BR",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "bun run dev --host 127.0.0.1 --port 5176 --strictPort",
    url: "http://127.0.0.1:5176/admin/",
    reuseExistingServer: false,
  },
});
