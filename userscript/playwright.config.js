import { defineConfig, devices } from "@playwright/test";

// A second-monitor-sized window. The focus line is a fraction of the viewport
// height, so it has to be deterministic for the selection assertions -- and
// each device preset carries a viewport of its own that would otherwise win.
const VIEWPORT = { width: 1280, height: 900 };

/**
 * The cross-browser suite: the shipped bundle, in the engines this project
 * says it supports.
 *
 * Each test starts its own daemon, so files must not race for a port -- one
 * worker per project, and the ports themselves are derived from the worker
 * index in tests/browser/fixture.js.
 */
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.spec.js",
  // A daemon handshake plus a couple of seconds of real scrolling; the
  // default 30s leaves nothing for a slow first launch.
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    // The real origin: permalinks resolve to real pathnames, so detectMode
    // keys off the same strings it sees in production.
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
