// Browser end-to-end tests (e2e/*.spec.ts). globalSetup stands up the real stack:
// a throwaway dental clinic + the real Go API (backend/tests/e2estack, against
// TEST_DATABASE_URL) and the Vite dev server proxying /api to it. Tests run in the
// system Google Chrome (channel "chrome"); no Playwright browser download is needed.
//
//   npm run test:e2e                      # whole suite
//   npx playwright test -g REG-E2E-003    # one test by ID
import { defineConfig } from "@playwright/test";

export const E2E_PORT = 5197;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // One clinic is shared; specs create what they need with unique names, but they
  // run serially so a slow API on a dev laptop does not turn into flaky timeouts.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  // CI keeps an HTML report as an artifact when something fails.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    // System Chrome locally; CI sets E2E_BROWSER_CHANNEL=chromium to use the browser
    // installed by `npx playwright install chromium`.
    channel: process.env.E2E_BROWSER_CHANNEL === "chromium" ? undefined : (process.env.E2E_BROWSER_CHANNEL || "chrome"),
    headless: true,
    // The browser runs on the clinic's clock, as every clinic computer does. On the
    // test host's own zone (New York here, UTC in CI) the app's "today" was a day
    // behind Addis for part of every night, and REG-E2E-010 failed (2026-10-04).
    timezoneId: "Africa/Addis_Ababa",
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
