import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Two projects rather than environmentMatchGlobs, which vitest deprecated:
    // most tests are pure logic and run far faster without a DOM, while the
    // *.dom.test.js files need one.
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.js"],
          exclude: ["tests/*.dom.test.js"],
        },
      },
      {
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/*.dom.test.js"],
        },
      },
    ],
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
      // Every module reads 100%. These sit just below that: high enough
      // that a real regression fails the build rather than being absorbed
      // by slack, with enough give that one awkward-to-reach line does not.
      thresholds: {
        statements: 98,
        branches: 97,
        functions: 98,
        lines: 98,
      },
    },
  },
});
