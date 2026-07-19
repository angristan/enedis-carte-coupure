import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "frontend",
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
