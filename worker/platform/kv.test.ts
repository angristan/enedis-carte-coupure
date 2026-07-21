import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { MemoryKVLayer } from "./memory-kv.js";
import { parseDuration } from "./config.js";
import {
  RawHttp,
  RawHttpLive,
  UpstreamCoordinatorClient,
} from "./http.js";
import { KVStore } from "./kv.js";
import { sha256Hex } from "../domain/util.js";

const CoordinatorTest = Layer.succeed(UpstreamCoordinatorClient)({
  request: () =>
    Effect.succeed({
      ok: true,
      status: 200,
      statusText: "OK",
      text: "not-json",
    }),
});
const HttpTest = RawHttpLive.pipe(Layer.provide(CoordinatorTest));

describe("worker boundaries", () => {
  layer(MemoryKVLayer)((it) => {
    it.effect("round-trips and decodes typed cache values", () =>
      Effect.gen(function* () {
        const cache = yield* KVStore;
        yield* cache.set("sample", { ok: true }, 60);
        const value = yield* cache.get(
          "sample",
          Schema.Struct({ ok: Schema.Boolean }),
        );
        assert.deepEqual(value, { ok: true });
      }));

    it.effect("rejects malformed cached values", () =>
      Effect.gen(function* () {
        const cache = yield* KVStore;
        yield* cache.set("sample", { ok: "not-boolean" });
        const exit = yield* Effect.exit(
          cache.get("sample", Schema.Struct({ ok: Schema.Boolean })),
        );
        assert.strictEqual(exit._tag, "Failure");
      }));
  });

  layer(HttpTest)((it) => {
    it.effect("classifies malformed upstream JSON", () =>
      Effect.gen(function* () {
        const http = yield* RawHttp;
        const exit = yield* Effect.exit(
          http.json({
            provider: "test",
            operation: "test.fetch",
            url: "https://example.test",
          }, Schema.Struct({ ok: Schema.Boolean })),
        );
        assert.strictEqual(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          assert.include(String(exit.cause), "UpstreamDecodeError");
        }
      }));
  });

  it.effect("creates deterministic cache hashes", () =>
    Effect.gen(function* () {
      const first = yield* sha256Hex("payload");
      const second = yield* sha256Hex("payload");
      assert.strictEqual(first, second);
      assert.strictEqual(first.length, 64);
    }));

  it("parses duration configuration without throwing", () => {
    assert.strictEqual(parseDuration("7d", 1), 604_800);
    assert.strictEqual(parseDuration("not-a-duration", 30), 30);
  });
});
