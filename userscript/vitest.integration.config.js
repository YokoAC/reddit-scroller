import { defineConfig } from "vitest/config";

// The integration suite starts a real daemon per test, so it needs a longer
// timeout than the unit suite and must not run files in parallel -- they all
// bind the same port.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/*.test.js"],
    testTimeout: 30000,
    hookTimeout: 40000,
    fileParallelism: false,
  },
});
