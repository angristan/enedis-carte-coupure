import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["worker/**/*.test.js", "railway-redirect/**/*.test.js"],
    environment: "node",
  },
});
