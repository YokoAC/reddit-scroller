import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    environmentMatchGlobs: [["tests/*.dom.test.js", "jsdom"]],
    // Unit tests only. The integration suite needs a real daemon, so it
    // runs separately via `npm run test:integration`.
    include: ["tests/*.test.js"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // main.js is covered by tests/main.test.js, which bundles it with
      // esbuild and evaluates it inside a fresh jsdom window per test. That
      // isolation is what makes those tests trustworthy -- each gets its own
      // window, with no listeners or timers surviving from the last -- but it
      // means v8 cannot attribute the executed code back to this file, so it
      // would report 0% however much is exercised. Excluding it keeps the
      // number honest about what is actually measured rather than diluting it
      // with a file the tool is blind to.
      exclude: ["src/main.js"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 90,
        lines: 95,
      },
    },
  },
});
