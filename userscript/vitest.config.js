import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Two projects (environmentMatchGlobs is deprecated): logic runs fast
    // without a DOM; only *.dom.test.js gets jsdom.
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
      // tests/main.test.js bundles main.js into a fresh jsdom window per test,
      // so nothing leaks between tests; v8 cannot map that back to the file
      // and would report 0%. Excluded rather than counted wrongly.
      exclude: ["src/main.js"],
      reporter: ["text", "html", "json-summary"],
      // Just under the 100% every module reaches: a real regression fails,
      // one awkward-to-reach line does not.
      thresholds: {
        statements: 98,
        branches: 97,
        functions: 98,
        lines: 98,
      },
    },
  },
});
