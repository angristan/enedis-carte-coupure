import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["worker/**/*.test.js"],
    environment: "node",
  },
});
