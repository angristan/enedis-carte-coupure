import { Context, Effect, Layer, Schema } from "effect";
import { CacheError } from "../domain/errors.js";
import { WorkerConfig } from "./config.js";

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
            namespace.get(storageKey, {
              type: "json",
              cacheTtl: Math.max(60, cacheTtl),
            }),
          catch: (cause) => CacheError.make({ operation: "get", key, cause }),
        });
        if (value === null) return null;

        return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError((cause) =>
            CacheError.make({ operation: "decode", key, cause })
          ),
        );
      },
    );

    const set = Effect.fn("KVStore.set")(
      function* (key: string, value: unknown, expirationTtl?: number) {
        if (!namespace || expirationTtl !== undefined && expirationTtl <= 0) {
          return;
        }

        const storageKey = fullKey(key);
        const options: KVNamespacePutOptions = {};
        if (expirationTtl !== undefined) {
          options.expirationTtl = Math.max(60, Math.ceil(expirationTtl));
        }

        yield* Effect.tryPromise({
          try: () => namespace.put(storageKey, JSON.stringify(value), options),
          catch: (cause) => CacheError.make({ operation: "set", key, cause }),
        });
      },
    );

    return { get, set };
  }));
}
