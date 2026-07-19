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

export interface WorkerEnv {
  readonly ASSETS: Fetcher;
  readonly CACHE?: KVNamespace;
  readonly CACHE_PREFIX?: string;
  readonly OUTAGE_CACHE_TTL?: string;
  readonly OUTAGE_CACHE_STALE_TTL?: string;
  readonly COMMUNES_CACHE_TTL?: string;
}

export class WorkerConfig extends Context.Service<WorkerConfig, {
  readonly cachePrefix: string;
  readonly outageCacheTtl: number;
  readonly outageStaleTtl: number;
  readonly communesCacheTtl: number;
}>()("WorkerConfig") {}

const EnvironmentSchema = Schema.Struct({
  CACHE_PREFIX: Schema.optionalKey(Schema.String),
  OUTAGE_CACHE_TTL: Schema.optionalKey(Schema.String),
  OUTAGE_CACHE_STALE_TTL: Schema.optionalKey(Schema.String),
  COMMUNES_CACHE_TTL: Schema.optionalKey(Schema.String),
});

export function configLayer(env: WorkerEnv) {
  return Layer.effect(
    WorkerConfig,
    Schema.decodeUnknownEffect(EnvironmentSchema)(env).pipe(
      Effect.map((decoded) => {
        const outageCacheTtl = parseDuration(
          decoded.OUTAGE_CACHE_TTL,
          15 * 60,
        );
        return {
          cachePrefix: decoded.CACHE_PREFIX ?? "enedis-carte-coupure",
          outageCacheTtl,
          outageStaleTtl: parseDuration(
            decoded.OUTAGE_CACHE_STALE_TTL,
            24 * 60 * 60,
          ),
          communesCacheTtl: parseDuration(
            decoded.COMMUNES_CACHE_TTL,
            7 * 24 * 60 * 60,
          ),
        };
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
}

export class RawHttp extends Context.Service<RawHttp, {
  readonly json: <A>(
    request: HttpRequest,
    schema: Schema.ConstraintDecoder<A, never>,
  ) => Effect.Effect<A, UpstreamError>;
}>()("RawHttp") {}

export const RawHttpLive = Layer.effect(RawHttp)(Effect.gen(function* () {
  const requestContext = yield* RequestContext;

  const json = Effect.fn("RawHttp.json")(
    function* <A>(
      request: HttpRequest,
      schema: Schema.ConstraintDecoder<A, never>,
    ) {
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          tracedPromise(
            requestContext.trace,
            request.operation,
            request.attributes ?? {},
            async (span) => {
              const response = await fetch(request.url, {
                ...request.init,
                signal,
              });
              span.setAttribute("http.response.status_code", response.status);
              return { response, text: await response.text() };
            },
          ),
        catch: (cause) =>
          UpstreamTransportError.make({
            provider: request.provider,
            operation: request.operation,
            cause,
          }),
      });

      if (!result.response.ok) {
        return yield* UpstreamStatusError.make({
          provider: request.provider,
          status: result.response.status,
          message:
            `${request.provider} returned ${result.response.status} ${result.response.statusText}: ${
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
