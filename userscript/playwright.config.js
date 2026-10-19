import { defineConfig, devices } from "@playwright/test";

// Fixed size: the focus line is a fraction of the viewport height, and each
// device preset would otherwise bring its own.
const VIEWPORT = { width: 1280, height: 900 };

/**
 * The shipped bundle in both supported engines. One worker: each test starts a
 * daemon on a port derived from the worker index (tests/browser/fixture.js).
 */
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.spec.js",
  // Daemon handshake plus seconds of real scrolling; 30s is tight on a cold start.
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    // Real origin, so detectMode sees the pathnames it sees in production.
    baseURL: "https://www.reddit.com/",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORT },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: VIEWPORT },
    },
  ],
});
