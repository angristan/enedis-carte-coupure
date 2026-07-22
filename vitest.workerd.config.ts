import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

process.env.CURSOR_SIGNING_SECRET ??= "local-cursor-signing-secret-at-least-32-bytes";
process.env.SESSION_SIGNING_SECRET ??= "local-session-signing-secret-at-least-32-bytes";
process.env.TURNSTILE_SECRET_KEY ??= "1x0000000000000000000000000000000AA";

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          CURSOR_SIGNING_SECRET: "local-cursor-signing-secret-at-least-32-bytes",
          SESSION_SIGNING_SECRET: "local-session-signing-secret-at-least-32-bytes",
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    name: "workerd",
    include: ["worker/**/*.workerd.test.ts"],
  },
});
