import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  boundsForCommune,
  CommuneDirectory,
  CommuneDirectoryLive,
  enedisQueryForCommune,
} from "./communes.js";
import type { Commune } from "./models.js";
import { KVStore, RawHttp, WorkerConfig } from "./platform.js";

const requestedUrls: Array<string> = [];
const intersectionResponse = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[2, 48], [2.1, 48], [2.1, 48.1], [2, 48.1], [2, 48]]],
      },
      properties: {
        nom_com: "First",
        insee_com: "78001",
        code_postal: "78000",
      },
    },
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[2.1, 48], [2.2, 48], [2.2, 48.1], [2.1, 48.1], [2.1, 48]]],
      },
      properties: {
        nom_com: "Second",
        insee_com: "78002",
        code_postal: null,
      },
    },
  ],
};

const CommuneDirectoryTest = CommuneDirectoryLive.pipe(
  Layer.provide(Layer.mergeAll(
    Layer.succeed(RawHttp)({
      json: (request, schema) =>
        Effect.gen(function* () {
          requestedUrls.push(String(request.url));
          return yield* Schema.decodeUnknownEffect(schema)(
            intersectionResponse,
          ).pipe(Effect.orDie);
        }),
    }),
    Layer.succeed(KVStore)({
      get: () => Effect.succeed(null),
      set: () => Effect.void,
    }),
    Layer.succeed(WorkerConfig)({
      cachePrefix: "test",
      outageCacheTtl: 0,
      outageStaleTtl: 0,
      communesCacheTtl: 60,
      production: false,
      appOrigin: "http://127.0.0.1:5173",
      turnstileSiteKey: "test-site-key",
      turnstileSecretKey: "test-secret-key",
      turnstileHostname: "",
      sessionSigningSecret: "test-session-signing-secret-00000000",
      cursorSigningSecret: "test-cursor-signing-secret-000000000",
      sessionTtl: 1800,
      cursorTtl: 600,
    }),
  )),
);

const commune: Commune = {
  name: "Paris",
  code: "75056",
  postcodes: ["75001"],
  center: { type: "Point", coordinates: [2.35, 48.85] },
  contour: {
    type: "Polygon",
    coordinates: [[[2, 48], [3, 48], [3, 49], [2, 49], [2, 48]]],
  },
};

describe("commune helpers", () => {
  layer(CommuneDirectoryTest)((it) => {
    it.effect("loads every intersecting feature in one query", () =>
      Effect.gen(function* () {
        requestedUrls.length = 0;
        const directory = yield* CommuneDirectory;
        const communes = yield* directory.forBounds({
          south: 48,
          west: 2,
          north: 48.1,
          east: 2.2,
        }, 30);

        assert.deepEqual(communes.map((item) => item.code), ["78001", "78002"]);
        assert.lengthOf(requestedUrls, 1);
        const url = new URL(requestedUrls[0] ?? "");
        assert.strictEqual(
          url.origin + url.pathname,
          "https://apicarto.ign.fr/api/limites-administratives/commune",
        );
        assert.strictEqual(url.searchParams.get("_limit"), "31");
        assert.include(url.searchParams.get("geom") ?? "", '"Polygon"');
      }));
  });

  it("builds an Enedis municipality query", () => {
    assert.deepEqual(enedisQueryForCommune(commune), {
      insee: "75056",
      type: "municipality",
      adresse: "Paris",
      CPVille: "Paris 75001",
      name: "Paris",
      district: "",
      city: "Paris",
      department: "75",
      longitude: "2.350000",
      latitude: "48.850000",
    });
  });

  it("derives padded contour bounds", () => {
    assert.deepEqual(boundsForCommune(commune), {
      south: 47.96,
      west: 1.96,
      north: 49.04,
      east: 3.04,
    });
  });
});
