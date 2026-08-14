import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    environmentMatchGlobs: [["tests/*.dom.test.js", "jsdom"]],
    include: ["tests/**/*.test.js"],
  },
});
