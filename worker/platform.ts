import { Context, Effect, Layer, Schema } from "effect";
import {
  CacheError,
  UpstreamDecodeError,
  type UpstreamError,
  UpstreamStatusError,
  UpstreamTransportError,
} from "./errors.js";
import type { NativeTraceContext, TraceAttributes } from "./trace.js";
import { tracedPromise } from "./trace.js";
import { CoordinatedResultSchema } from "./upstream-coordinator.js";
import type {
  CoordinatedRequest,
  CoordinatedResult,
} from "./upstream-coordinator.js";

export interface WorkerEnv {
  readonly ASSETS: Fetcher;
  readonly CACHE?: KVNamespace;
  readonly API_RATE_LIMITER?: RateLimit;
  readonly UPSTREAM_COORDINATOR?: DurableObjectNamespace;
  readonly CACHE_PREFIX?: string;
  readonly OUTAGE_CACHE_TTL?: string;
  readonly OUTAGE_CACHE_STALE_TTL?: string;
  readonly COMMUNES_CACHE_TTL?: string;
  readonly APP_ENV?: string;
  readonly APP_ORIGIN?: string;
  readonly TURNSTILE_SITE_KEY?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly TURNSTILE_HOSTNAME?: string;
  readonly SESSION_SIGNING_SECRET?: string;
  readonly CURSOR_SIGNING_SECRET?: string;
  readonly SESSION_TTL?: string;
  readonly CURSOR_TTL?: string;
}

export class WorkerConfig extends Context.Service<WorkerConfig, {
  readonly cachePrefix: string;
  readonly outageCacheTtl: number;
  readonly outageStaleTtl: number;
  readonly communesCacheTtl: number;
  readonly production: boolean;
  readonly appOrigin: string;
  readonly turnstileSiteKey: string;
  readonly turnstileSecretKey: string;
  readonly turnstileHostname: string;
  readonly sessionSigningSecret: string;
  readonly cursorSigningSecret: string;
  readonly sessionTtl: number;
  readonly cursorTtl: number;
}>()("WorkerConfig") {}

const EnvironmentSchema = Schema.Struct({
  CACHE_PREFIX: Schema.optionalKey(Schema.String),
  OUTAGE_CACHE_TTL: Schema.optionalKey(Schema.String),
  OUTAGE_CACHE_STALE_TTL: Schema.optionalKey(Schema.String),
  COMMUNES_CACHE_TTL: Schema.optionalKey(Schema.String),
  APP_ENV: Schema.optionalKey(Schema.String),
  APP_ORIGIN: Schema.optionalKey(Schema.String),
  TURNSTILE_SITE_KEY: Schema.optionalKey(Schema.String),
  TURNSTILE_SECRET_KEY: Schema.optionalKey(Schema.String),
  TURNSTILE_HOSTNAME: Schema.optionalKey(Schema.String),
  SESSION_SIGNING_SECRET: Schema.optionalKey(Schema.String),
  CURSOR_SIGNING_SECRET: Schema.optionalKey(Schema.String),
  SESSION_TTL: Schema.optionalKey(Schema.String),
  CURSOR_TTL: Schema.optionalKey(Schema.String),
});

export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_KEY =
  "1x0000000000000000000000000000000AA";
const LOCAL_SIGNING_SECRET = "local-development-signing-secret-only";

export function configLayer(env: WorkerEnv) {
  return Layer.effect(
    WorkerConfig,
    Schema.decodeUnknownEffect(EnvironmentSchema)(env).pipe(
      Effect.flatMap((decoded) => {
        const production = decoded.APP_ENV === "production";
        const turnstileSecretKey = decoded.TURNSTILE_SECRET_KEY ??
          (production ? "" : TURNSTILE_TEST_SECRET_KEY);
        const sessionSigningSecret = decoded.SESSION_SIGNING_SECRET ??
          (production ? "" : LOCAL_SIGNING_SECRET);
        const cursorSigningSecret = decoded.CURSOR_SIGNING_SECRET ??
          (production ? "" : `${LOCAL_SIGNING_SECRET}:cursor`);
        if (
          production &&
          ((decoded.TURNSTILE_SITE_KEY ?? "").length === 0 ||
            turnstileSecretKey.length === 0 || sessionSigningSecret.length < 32 ||
            cursorSigningSecret.length < 32)
        ) {
          return Effect.die(
            new Error("production Turnstile and session secrets are required"),
          );
        }
        const outageCacheTtl = parseDuration(
          decoded.OUTAGE_CACHE_TTL,
          15 * 60,
        );
        return Effect.succeed({
          cachePrefix: decoded.CACHE_PREFIX ?? "enedis-carte-coupure",
          outageCacheTtl,
          outageStaleTtl: parseDuration(
            decoded.OUTAGE_CACHE_STALE_TTL,
            7 * 24 * 60 * 60,
          ),
          communesCacheTtl: parseDuration(
            decoded.COMMUNES_CACHE_TTL,
            7 * 24 * 60 * 60,
          ),
          production,
          appOrigin: decoded.APP_ORIGIN ?? "http://127.0.0.1:5173",
          turnstileSiteKey: decoded.TURNSTILE_SITE_KEY ??
            TURNSTILE_TEST_SITE_KEY,
          turnstileSecretKey,
          turnstileHostname: decoded.TURNSTILE_HOSTNAME ?? "",
          sessionSigningSecret,
          cursorSigningSecret,
          sessionTtl: parseDuration(decoded.SESSION_TTL, 30 * 60),
          cursorTtl: parseDuration(decoded.CURSOR_TTL, 10 * 60),
        });
      }),
      Effect.orDie,
    ),
  );
}

export class BackgroundTasks extends Context.Service<BackgroundTasks, {
  readonly schedule: (task: Effect.Effect<void>) => Effect.Effect<void>;
}>()("BackgroundTasks") {}

export function backgroundTasksLayer(
  context: ExecutionContext,
  run: (task: Effect.Effect<void>) => Promise<void>,
) {
  return Layer.succeed(BackgroundTasks)({
    schedule: (task) => Effect.sync(() => context.waitUntil(run(task))),
  });
}

export class RequestContext extends Context.Service<RequestContext, {
  readonly trace: NativeTraceContext;
}>()("RequestContext") {}

export function requestContextLayer(context: ExecutionContext) {
  return Layer.succeed(RequestContext)({ trace: context });
}

export interface HttpRequest {
  readonly provider: string;
  readonly operation: string;
  readonly url: string | URL;
  readonly init?: RequestInit;
  readonly attributes?: TraceAttributes;
  readonly dedupeKey?: string;
}

export class UpstreamCoordinatorClient
  extends Context.Service<UpstreamCoordinatorClient, {
    readonly request: (
      request: CoordinatedRequest,
    ) => Effect.Effect<CoordinatedResult, UpstreamError>;
  }>()("UpstreamCoordinatorClient") {}

export function upstreamCoordinatorLayer(env: WorkerEnv) {
  return Layer.succeed(UpstreamCoordinatorClient)({
    request: (request) => {
      const namespace = env.UPSTREAM_COORDINATOR;
      if (namespace === undefined) {
        return Effect.fail(UpstreamTransportError.make({
          provider: request.provider,
          operation: request.operation,
          cause: new Error("UPSTREAM_COORDINATOR binding is unavailable"),
        }));
      }
      const stub = namespace.get(namespace.idFromName(request.provider));
      return Effect.tryPromise({
        try: async () => {
          const response = await stub.fetch("https://coordinator.internal/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          });
          if (!response.ok) throw new Error(`coordinator returned ${response.status}`);
          return await response.json();
        },
        catch: (cause) =>
          UpstreamTransportError.make({
            provider: request.provider,
            operation: request.operation,
            cause,
          }),
      }).pipe(
        Effect.flatMap((payload) =>
          Schema.decodeUnknownEffect(CoordinatedResultSchema)(payload).pipe(
            Effect.mapError((cause) =>
              UpstreamDecodeError.make({
                provider: request.provider,
                message: cause.message,
              })
            ),
          )
        ),
      );
    },
  });
}

export class RawHttp extends Context.Service<RawHttp, {
  readonly json: <A>(
    request: HttpRequest,
    schema: Schema.ConstraintDecoder<A, never>,
  ) => Effect.Effect<A, UpstreamError>;
}>()("RawHttp") {}

export const RawHttpLive = Layer.effect(RawHttp)(Effect.gen(function* () {
  const coordinator = yield* UpstreamCoordinatorClient;

  const acceptOutcome = Effect.fn("RawHttp.acceptOutcome")(
    function* (request: HttpRequest, outcome: CoordinatedResult) {
      if (outcome.ok) return outcome;
      if (outcome.reason === "budget" || outcome.reason === "concurrency") {
        return yield* UpstreamStatusError.make({
          provider: request.provider,
          status: 429,
          message: `${outcome.message}; retry after ${outcome.retryAfter}s`,
        });
      }
      return yield* UpstreamTransportError.make({
        provider: request.provider,
        operation: request.operation,
        cause: new Error(outcome.message),
      });
    },
  );

  const json = Effect.fn("RawHttp.json")(
    function* <A>(
      request: HttpRequest,
      schema: Schema.ConstraintDecoder<A, never>,
    ) {
      const coordinatedRequest = yield* serializeHttpRequest(request);
      const outcome = yield* coordinator.request(coordinatedRequest);
      const result = yield* acceptOutcome(request, outcome);

      if (result.status < 200 || result.status >= 300) {
        return yield* UpstreamStatusError.make({
          provider: request.provider,
          status: result.status,
          message:
            `${request.provider} returned ${result.status} ${result.statusText}: ${
              result.text.slice(0, 180)
            }`,
        });
      }
      const unknownJson = yield* Effect.try({
        try: (): unknown => JSON.parse(result.text),
        catch: (cause) =>
          UpstreamDecodeError.make({
            provider: request.provider,
            message: `invalid JSON: ${String(cause)}`,
          }),
      });

      return yield* Schema.decodeUnknownEffect(schema)(unknownJson).pipe(
        Effect.mapError((error) =>
          UpstreamDecodeError.make({
            provider: request.provider,
            message: error.message,
          })
        ),
      );
    },
  );

  return { json };
}));

const serializeHttpRequest = Effect.fn("RawHttp.serialize")(function* (
  request: HttpRequest,
) {
  const body = yield* serializeBody(request);
  const method = request.init?.method?.toUpperCase() ?? "GET";
  const url = String(request.url);
  return {
    provider: request.provider,
    operation: request.operation,
    key: request.dedupeKey ?? `${method}:${url}:${body ?? ""}`,
    url,
    method,
    headers: Object.fromEntries(new Headers(request.init?.headers).entries()),
    ...(body === undefined ? {} : { body }),
  } satisfies CoordinatedRequest;
});

function serializeBody(
  request: HttpRequest,
): Effect.Effect<string | undefined, UpstreamTransportError> {
  const body = request.init?.body;
  if (body === undefined || body === null) return Effect.succeed(undefined);
  if (typeof body === "string") return Effect.succeed(body);
  if (body instanceof URLSearchParams) return Effect.succeed(body.toString());
  return Effect.fail(UpstreamTransportError.make({
    provider: request.provider,
    operation: request.operation,
    cause: new Error("unsupported coordinated request body"),
  }));
}

export class KVStore extends Context.Service<KVStore, {
  readonly get: <A>(
    key: string,
    schema: Schema.ConstraintDecoder<A, never>,
    cacheTtl?: number,
  ) => Effect.Effect<A | null, CacheError>;
  readonly set: (
    key: string,
    value: unknown,
    expirationTtl?: number,
  ) => Effect.Effect<void, CacheError>;
}>()("KVStore") {}

export function kvStoreLayer(namespace: KVNamespace | undefined) {
  return Layer.effect(KVStore)(Effect.gen(function* () {
    const config = yield* WorkerConfig;
    const requestContext = yield* RequestContext;

    const fullKey = (key: string): string =>
      config.cachePrefix ? `${config.cachePrefix}:${key}` : key;

    const get = Effect.fn("KVStore.get")(
      function* <A>(
        key: string,
        schema: Schema.ConstraintDecoder<A, never>,
        cacheTtl = 60,
      ) {
        if (!namespace) return null;
        const storageKey = fullKey(key);
        const value = yield* Effect.tryPromise({
          try: () =>
            tracedPromise(requestContext.trace, "cache.get", {
              "cache.key": key,
            }, () =>
              namespace.get(storageKey, {
                type: "json",
                cacheTtl: Math.max(60, cacheTtl),
              })),
          catch: (cause) => CacheError.make({ operation: "get", key, cause }),
        });
        if (value === null) {
          return null;
        }

        return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError((cause) =>
            CacheError.make({ operation: "decode", key, cause })
          ),
        );
      },
    );

    const set = Effect.fn("KVStore.set")(
      function* (key: string, value: unknown, expirationTtl?: number) {
        if (!namespace) return;
        const storageKey = fullKey(key);
        const options: KVNamespacePutOptions = {};
        if (expirationTtl !== undefined) {
          options.expirationTtl = Math.max(60, Math.ceil(expirationTtl));
        }

        yield* Effect.tryPromise({
          try: () =>
            tracedPromise(requestContext.trace, "cache.put", {
              "cache.key": key,
            }, () => namespace.put(storageKey, JSON.stringify(value), options)),
          catch: (cause) => CacheError.make({ operation: "set", key, cause }),
        });
      },
    );

    return { get, set };
  }));
}

export function parseDuration(
  value: string | undefined,
  fallbackSeconds: number,
): number {
  if (value === undefined) return fallbackSeconds;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) return fallbackSeconds;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  if (!Number.isFinite(amount) || amount < 0) return fallbackSeconds;
  if (unit === "ms") return amount / 1000;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 3600;
  if (unit === "d") return amount * 86400;
  return amount;
}
