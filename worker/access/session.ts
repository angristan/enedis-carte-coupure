import { Clock, Context, Effect, Layer, Option, Schedule, Schema } from "effect";
import type { SessionStatus } from "../../shared/api.js";
import {
  RateLimitExceeded,
  VerificationFailed,
  VerificationRequired,
} from "../domain/errors.js";
import { WorkerConfig, type WorkerEnv } from "../platform/config.js";
import { RawHttp } from "../platform/http.js";
import { signJson, verifyJson } from "./signing.js";
import { CryptoError } from "../domain/util.js";

const TURNSTILE_VERIFY_ENDPOINT =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION = "outages_access";
const PRODUCTION_COOKIE = "__Host-outages_session";
const LOCAL_COOKIE = "outages_session";
const RATE_LIMIT_RETRY_AFTER = 60;
const TURNSTILE_RETRY_POLICY = Schedule.recurs(1);

const TurnstileResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  hostname: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  "error-codes": Schema.optionalKey(Schema.Array(Schema.String)),
});

const SessionPayloadSchema = Schema.Struct({
  v: Schema.Literal(1),
  sid: Schema.String,
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
});

const decodeSession = Schema.decodeUnknownOption(SessionPayloadSchema);

export interface VerifiedSession {
  readonly id: string;
  readonly expiresAt: number;
}

export interface CreatedSession {
  readonly session: VerifiedSession;
  readonly cookie: string;
}

export class AccessControl extends Context.Service<AccessControl, {
  readonly status: (request: Request) => Effect.Effect<SessionStatus, CryptoError>;
  readonly validateCreationRequest: (
    request: Request,
  ) => Effect.Effect<void, VerificationFailed>;
  readonly create: (
    request: Request,
    token: string,
  ) => Effect.Effect<CreatedSession, VerificationFailed | CryptoError>;
  readonly require: (
    request: Request,
  ) => Effect.Effect<VerifiedSession, VerificationRequired | CryptoError>;
  readonly limit: (
    session: VerifiedSession,
  ) => Effect.Effect<void, RateLimitExceeded>;
}>()("AccessControl") {}

export function accessControlLayer(env: WorkerEnv) {
  return Layer.effect(AccessControl)(Effect.gen(function* () {
    const config = yield* WorkerConfig;
    const http = yield* RawHttp;
    const rateLimiter = env.API_RATE_LIMITER;
    if (config.production && rateLimiter === undefined) {
      return yield* Effect.die(
        new Error("API_RATE_LIMITER binding is required"),
      );
    }

    const read = Effect.fn("AccessControl.read")(function* (request: Request) {
      const value = cookieValue(request, cookieName(request));
      if (Option.isNone(value)) return Option.none<VerifiedSession>();
      const verified = yield* verifyJson(value.value, config.sessionSigningSecret);
      if (Option.isNone(verified)) return Option.none<VerifiedSession>();
      const decoded = decodeSession(verified.value);
      if (Option.isNone(decoded)) return Option.none<VerifiedSession>();
      const now = yield* Clock.currentTimeMillis;
      if (decoded.value.expiresAt <= now) return Option.none<VerifiedSession>();
      return Option.some({
        id: decoded.value.sid,
        expiresAt: decoded.value.expiresAt,
      });
    });

    const status = Effect.fn("AccessControl.status")(function* (
      request: Request,
    ) {
      const session = yield* read(request);
      return {
        verified: Option.isSome(session),
        turnstileSiteKey: config.turnstileSiteKey,
      } satisfies SessionStatus;
    });

    const validateCreationRequest = Effect.fn(
      "AccessControl.validateCreationRequest",
    )(function* (request: Request) {
      if (request.headers.get("Origin") !== config.appOrigin) {
        return yield* VerificationFailed.make({
          message: "session origin is not allowed",
        });
      }
    });

    const create = Effect.fn("AccessControl.create")(function* (
      request: Request,
      token: string,
    ) {
      yield* validateCreationRequest(request);
      if (token.length === 0 || token.length > 2048) {
        return yield* VerificationFailed.make({
          message: "Turnstile token is invalid",
        });
      }

      const form = new URLSearchParams();
      const idempotencyKey = crypto.randomUUID();
      form.set("secret", config.turnstileSecretKey);
      form.set("response", token);
      form.set("idempotency_key", idempotencyKey);
      const remoteIp = request.headers.get("CF-Connecting-IP");
      if (remoteIp !== null) form.set("remoteip", remoteIp);

      const outcome = yield* http.json({
        provider: "Turnstile",
        operation: "turnstile.verify",
        url: TURNSTILE_VERIFY_ENDPOINT,
        dedupeKey: `turnstile:${idempotencyKey}`,
        init: {
          method: "POST",
          body: form,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      }, TurnstileResponseSchema).pipe(
        Effect.retry(TURNSTILE_RETRY_POLICY),
        Effect.mapError((error) => {
          console.warn({
            event: "turnstile.siteverify_unavailable",
            errorTag: error._tag,
            errorMessage: error._tag === "UpstreamTransportError" &&
                error.cause instanceof Error
              ? error.cause.message
              : undefined,
          });
          return VerificationFailed.make({
            message: "Turnstile verification failed",
          });
        }),
      );

      const actionMatches = outcome.action === TURNSTILE_ACTION;
      const hostnameMatches = config.turnstileHostname.length === 0 ||
        outcome.hostname === config.turnstileHostname;
      if (
        !outcome.success ||
        (config.production && (!actionMatches || !hostnameMatches))
      ) {
        console.warn({
          event: "turnstile.verification_rejected",
          success: outcome.success,
          errorCodes: outcome["error-codes"] ?? [],
          actionMatches,
          hostnameMatches,
        });
        return yield* VerificationFailed.make({
          message: "Turnstile verification was rejected",
        });
      }

      const now = yield* Clock.currentTimeMillis;
      const expiresAt = now + config.sessionTtl * 1000;
      const session = {
        id: randomSessionId(),
        expiresAt,
      } satisfies VerifiedSession;
      const value = yield* signJson({
        v: 1,
        sid: session.id,
        issuedAt: now,
        expiresAt,
      }, config.sessionSigningSecret);

      return {
        session,
        cookie: serializeCookie(
          cookieName(request),
          value,
          Math.max(1, Math.floor(config.sessionTtl)),
          new URL(request.url).protocol === "https:",
        ),
      } satisfies CreatedSession;
    });

    const requireSession = Effect.fn("AccessControl.require")(function* (
      request: Request,
    ) {
      const session = yield* read(request);
      if (Option.isNone(session)) {
        return yield* VerificationRequired.make({
          message: "human verification is required",
        });
      }
      return session.value;
    });

    const limit = Effect.fn("AccessControl.limit")(function* (
      session: VerifiedSession,
    ) {
      if (rateLimiter === undefined) return;
      const exceeded = () => RateLimitExceeded.make({
        retryAfter: RATE_LIMIT_RETRY_AFTER,
        message: "too many outage requests",
      });
      const outcome = yield* Effect.tryPromise({
        try: () => rateLimiter.limit({ key: session.id }),
        catch: exceeded,
      });
      if (!outcome.success) return yield* exceeded();
    });

    return {
      status,
      validateCreationRequest,
      create,
      require: requireSession,
      limit,
    };
  }));
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function cookieName(request: Request): string {
  return new URL(request.url).protocol === "https:"
    ? PRODUCTION_COOKIE
    : LOCAL_COOKIE;
}

function cookieValue(request: Request, name: string): Option.Option<string> {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return matches.length === 1 && matches[0] !== undefined
    ? Option.some(matches[0])
    : Option.none();
}

function serializeCookie(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export const testExports = { cookieValue, serializeCookie };
