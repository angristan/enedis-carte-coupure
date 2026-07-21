import { Clock, Effect, Layer, Schema } from "effect";
import { CacheError } from "../domain/errors.js";
import { KVStore } from "./kv.js";

interface MemoryEntry {
  readonly value: unknown;
  readonly expiresAt: number | null;
}

export const MemoryKVLayer = Layer.effect(KVStore)(Effect.gen(function* () {
  const entries = new Map<string, MemoryEntry>();
  const get = Effect.fn("MemoryKV.get")(
    function* <A>(key: string, schema: Schema.ConstraintDecoder<A, never>) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      const now = yield* Clock.currentTimeMillis;
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        entries.delete(key);
        return null;
      }
      return yield* Schema.decodeUnknownEffect(schema)(entry.value).pipe(
        Effect.mapError((cause) =>
          CacheError.make({ operation: "decode", key, cause })
        ),
      );
    },
  );
  const set = Effect.fn("MemoryKV.set")(
    function* (key: string, value: unknown, expirationTtl?: number) {
      const now = yield* Clock.currentTimeMillis;
      entries.set(key, {
        value,
        expiresAt: expirationTtl === undefined
          ? null
          : now + expirationTtl * 1000,
      });
    },
  );
  return { get, set };
}));
