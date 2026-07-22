import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "unit",
    include: [
      "worker/**/*.test.ts",
      "frontend/src/**/*.test.ts",
      "railway-redirect/**/*.test.ts",
    ],
    exclude: ["worker/**/*.workerd.test.ts"],
    environment: "node",
  },
});
