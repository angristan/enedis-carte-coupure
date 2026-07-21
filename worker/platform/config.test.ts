import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  loadWorkerConfig,
  TURNSTILE_TEST_SITE_KEY,
} from "./config.js";

const productionConfig = {
  APP_ENV: "production",
  APP_ORIGIN: "https://enedis.example.com",
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "secret-key",
  TURNSTILE_HOSTNAME: "enedis.example.com",
  SESSION_SIGNING_SECRET: "session-signing-secret-at-least-32-bytes",
  CURSOR_SIGNING_SECRET: "cursor-signing-secret-at-least-32-bytes",
};

describe("Worker configuration", () => {
  it.effect("loads complete production configuration", () =>
    Effect.gen(function* () {
      const config = yield* loadWorkerConfig(productionConfig);

      assert.isTrue(config.production);
      assert.strictEqual(config.appOrigin, "https://enedis.example.com");
      assert.strictEqual(config.turnstileHostname, "enedis.example.com");
    }));

  it.effect("fails closed when the production hostname is missing", () => {
    const { TURNSTILE_HOSTNAME: _, ...missingHostname } = productionConfig;

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(loadWorkerConfig(missingHostname));
      assert.strictEqual(exit._tag, "Failure");
    });
  });

  it.effect("uses Cloudflare test credentials only in development", () =>
    Effect.gen(function* () {
      const config = yield* loadWorkerConfig({});

      assert.isFalse(config.production);
      assert.strictEqual(config.turnstileSiteKey, TURNSTILE_TEST_SITE_KEY);
      assert.strictEqual(config.appOrigin, "http://127.0.0.1:5173");
    }));
});
