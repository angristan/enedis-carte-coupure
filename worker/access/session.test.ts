import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { WorkerConfig, type WorkerEnv } from "../platform/config.js";
import { RawHttp } from "../platform/http.js";
import { AccessControl, accessControlLayer, testExports } from "./session.js";

const baseConfig = {
  cachePrefix: "test",
  outageCacheTtl: 0,
  outageStaleTtl: 0,
  communesCacheTtl: 60,
  production: true,
  appOrigin: "https://app.example.test",
  turnstileSiteKey: "test-site-key",
  turnstileSecretKey: "test-secret-key",
  turnstileHostname: "app.example.test",
  sessionSigningSecret: "test-session-signing-secret-00000000",
  cursorSigningSecret: "test-cursor-signing-secret-000000000",
  sessionTtl: 1,
  cursorTtl: 600,
};

const unusedAssets: Fetcher = {
  fetch: () => Promise.resolve(new Response()),
  connect: () => {
    throw new Error("unused test binding");
  },
};

const allowingRateLimiter: RateLimit = {
  limit: () => Promise.resolve({ success: true }),
};

const denyingRateLimiter: RateLimit = {
  limit: () => Promise.resolve({ success: false }),
};

const rejectingRateLimiter: RateLimit = {
  limit: () => Promise.reject(new Error("rate-limit binding unavailable")),
};

const validTurnstileResponse = {
  success: true,
  action: "outages_access",
  hostname: baseConfig.turnstileHostname,
};

function environment(rateLimiter: RateLimit | undefined): WorkerEnv {
  if (rateLimiter === undefined) return { ASSETS: unusedAssets };
  return { ASSETS: unusedAssets, API_RATE_LIMITER: rateLimiter };
}

function makeAccessLayer(
  turnstileResponse: unknown,
  rateLimiter: RateLimit = allowingRateLimiter,
) {
  const dependencies = Layer.mergeAll(
    Layer.succeed(WorkerConfig)(baseConfig),
    Layer.succeed(RawHttp)({
      json: (_request, schema) =>
        Schema.decodeUnknownEffect(schema)(turnstileResponse).pipe(
          Effect.orDie,
        ),
    }),
  );

  return accessControlLayer(environment(rateLimiter)).pipe(
    Layer.provide(dependencies),
  );
}

function creationRequest(origin = baseConfig.appOrigin): Request {
  return new Request(`${baseConfig.appOrigin}/api/session`, {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "192.0.2.1",
    },
  });
}

const AccessTest = makeAccessLayer(validTurnstileResponse);
const WrongActionTest = makeAccessLayer({
  ...validTurnstileResponse,
  action: "wrong_action",
});
const WrongHostnameTest = makeAccessLayer({
  ...validTurnstileResponse,
  hostname: "attacker.example.test",
});
const DenyingRateLimitTest = makeAccessLayer(
  validTurnstileResponse,
  denyingRateLimiter,
);
const RejectingRateLimitTest = makeAccessLayer(
  validTurnstileResponse,
  rejectingRateLimiter,
);

describe("session creation access control", () => {
  layer(AccessTest)((it) => {
    it.effect("validates the request origin independently", () =>
      Effect.gen(function* () {
        const access = yield* AccessControl;
        yield* access.validateCreationRequest(creationRequest());

        const error = yield* Effect.flip(
          access.validateCreationRequest(
            creationRequest("https://attacker.example.test"),
          ),
        );
        assert.strictEqual(error._tag, "VerificationFailed");
        assert.strictEqual(error.message, "session origin is not allowed");
      }));

    it.effect("defensively revalidates the origin during creation", () =>
      Effect.gen(function* () {
        const access = yield* AccessControl;
        const error = yield* Effect.flip(
          access.create(
            creationRequest("https://attacker.example.test"),
            "turnstile-token",
          ),
        );
        assert.strictEqual(error._tag, "VerificationFailed");
        assert.strictEqual(error.message, "session origin is not allowed");
      }));

    it.effect("requires a valid signed session and expires it", () =>
      Effect.gen(function* () {
        const access = yield* AccessControl;
        const created = yield* access.create(
          creationRequest(),
          "turnstile-token",
        );
        const authenticatedRequest = new Request(
          `${baseConfig.appOrigin}/api/outages`,
          { headers: { Cookie: created.cookie } },
        );

        const verified = yield* access.require(authenticatedRequest);
        assert.strictEqual(verified.id, created.session.id);
        assert.strictEqual(verified.expiresAt, created.session.expiresAt);

        yield* TestClock.adjust("1 second");
        const expired = yield* Effect.flip(
          access.require(authenticatedRequest),
        );
        assert.strictEqual(expired._tag, "VerificationRequired");
      }));
  });

  layer(WrongActionTest)((it) => {
    it.effect("rejects a mismatched production Turnstile action", () =>
      Effect.gen(function* () {
        const access = yield* AccessControl;
        const error = yield* Effect.flip(
          access.create(creationRequest(), "turnstile-token"),
        );
        assert.strictEqual(error._tag, "VerificationFailed");
        assert.strictEqual(
          error.message,
          "Turnstile verification was rejected",
        );
      }));
  });

  layer(WrongHostnameTest)((it) => {
    it.effect("rejects a mismatched production Turnstile hostname", () =>
      Effect.gen(function* () {
        const access = yield* AccessControl;
        const error = yield* Effect.flip(
          access.create(creationRequest(), "turnstile-token"),
        );
        assert.strictEqual(error._tag, "VerificationFailed");
        assert.strictEqual(
          error.message,
          "Turnstile verification was rejected",
        );
      }));
  });
});

describe("production rate limiting", () => {
  const session = { id: "session-to-limit", expiresAt: 10_000 };

  layer(DenyingRateLimitTest)((it) => {
    it.effect("fails closed when the binding denies the session", () =>
      Effect.gen(function* () {
        const access = yield* AccessControl;
        const error = yield* Effect.flip(access.limit(session));
        assert.strictEqual(error._tag, "RateLimitExceeded");
        assert.strictEqual(error.retryAfter, 60);
      }));
  });

  layer(RejectingRateLimitTest)((it) => {
    it.effect("fails closed when the binding rejects", () =>
      Effect.gen(function* () {
        const access = yield* AccessControl;
        const error = yield* Effect.flip(access.limit(session));
        assert.strictEqual(error._tag, "RateLimitExceeded");
        assert.strictEqual(error.retryAfter, 60);
      }));
  });
});

describe("verified session cookies", () => {
  it("emits host-only secure cookie attributes", () => {
    const cookie = testExports.serializeCookie(
      "__Host-outages_session",
      "signed-value",
      1800,
      true,
    );
    assert.include(cookie, "__Host-outages_session=signed-value");
    assert.include(cookie, "Path=/");
    assert.include(cookie, "HttpOnly");
    assert.include(cookie, "Secure");
    assert.include(cookie, "SameSite=Strict");
    assert.notInclude(cookie, "Domain=");
  });

  it("rejects duplicate session cookies", () => {
    const request = new Request("https://example.test", {
      headers: {
        Cookie: "session=first; other=value; session=second",
      },
    });
    assert.isTrue(Option.isNone(testExports.cookieValue(request, "session")));
  });
});
