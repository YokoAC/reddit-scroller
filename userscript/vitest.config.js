import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    environmentMatchGlobs: [["tests/*.dom.test.js", "jsdom"]],
    // Unit tests only. The integration suite needs a real daemon, so it
    // runs separately via `npm run test:integration`.
    include: ["tests/*.test.js"],
  },
});
