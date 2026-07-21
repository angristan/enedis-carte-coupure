import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  UpstreamStatusError,
  UpstreamTransportError,
} from "../domain/errors.js";
import { RawHttp } from "../platform/http.js";
import { KVStore } from "../platform/kv.js";
import {
  GEOCODE_FALLBACK_ENDPOINT,
  GEOCODE_PRIMARY_ENDPOINT,
} from "../sources.js";
import { Geocoder, GeocoderLive } from "./geocode.js";

type GeocodeReply =
  | { readonly payload: unknown }
  | { readonly failure: true }
  | { readonly rateLimited: true };

const replies: Array<GeocodeReply> = [];
const requestedEndpoints: Array<string> = [];
const cachedValues = new Map<string, unknown>();

const GeocoderTest = GeocoderLive.pipe(
  Layer.provide(Layer.mergeAll(
    Layer.succeed(RawHttp)({
      json: (request, schema) => {
        const url = new URL(String(request.url));
        requestedEndpoints.push(url.origin + url.pathname);
        const reply = replies.shift();

        if (reply !== undefined && "rateLimited" in reply) {
          return Effect.fail(UpstreamStatusError.make({
            provider: request.provider,
            status: 429,
            message: "coordinator queue expired",
          }));
        }
        if (reply === undefined || "failure" in reply) {
          return Effect.fail(UpstreamTransportError.make({
            provider: request.provider,
            operation: request.operation,
            cause: new Error("test geocoder failure"),
          }));
        }

        return Schema.decodeUnknownEffect(schema)(reply.payload).pipe(
          Effect.orDie,
        );
      },
    }),
    Layer.succeed(KVStore)({
      get: (key, schema) => {
        const value = cachedValues.get(key);
        return value === undefined
          ? Effect.succeed(null)
          : Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie);
      },
      set: (key, value) => Effect.sync(() => {
        cachedValues.set(key, value);
      }),
    }),
  )),
);

function reset(replacement: ReadonlyArray<GeocodeReply>): void {
  replies.splice(0, replies.length, ...replacement);
  requestedEndpoints.length = 0;
  cachedValues.clear();
}

describe("geocoder fallback", () => {
  layer(GeocoderTest)((it) => {
    it.effect("runs fallback only once after a primary miss", () =>
      Effect.gen(function* () {
        reset([
          { payload: { features: [] } },
          { failure: true },
        ]);
        const geocoder = yield* Geocoder;
        const result = yield* geocoder.street("Rue absente Paris");

        assert.strictEqual(result.status, "error");
        assert.deepEqual(requestedEndpoints, [
          GEOCODE_PRIMARY_ENDPOINT,
          GEOCODE_FALLBACK_ENDPOINT,
        ]);
      }));

    it.effect("runs fallback only once after a primary failure", () =>
      Effect.gen(function* () {
        reset([
          { failure: true },
          { failure: true },
        ]);
        const geocoder = yield* Geocoder;
        const result = yield* geocoder.street("Rue indisponible Paris");

        assert.strictEqual(result.status, "error");
        assert.deepEqual(requestedEndpoints, [
          GEOCODE_PRIMARY_ENDPOINT,
          GEOCODE_FALLBACK_ENDPOINT,
        ]);
      }));

    it.effect("does not retry a coordinator limit through fallback", () =>
      Effect.gen(function* () {
        reset([{ rateLimited: true }]);
        const geocoder = yield* Geocoder;
        const result = yield* geocoder.street("Rue limitée Paris");

        assert.strictEqual(result.status, "error");
        assert.deepEqual(requestedEndpoints, [GEOCODE_PRIMARY_ENDPOINT]);
      }));
  });
});
