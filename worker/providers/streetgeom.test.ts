import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { Bounds, Position } from "../domain/geo.js";
import type { StreetGeometry } from "../domain/models.js";
import type { HttpRequest } from "../platform/http.js";
import { RawHttp } from "../platform/http.js";
import { KVStore } from "../platform/kv.js";
import { filterStreetGeometryNearPoint } from "./streetgeom-geometry.js";
import {
  buildStreetLookupQuery,
  streetGeometriesFromPayload,
  streetKey,
} from "./streetgeom-overpass.js";
import { STREET_GEOMETRY_PRIMARY_ENDPOINT } from "../sources.js";
import {
  StreetGeometryProvider,
  StreetGeometryProviderLive,
} from "./streetgeom.js";

const bounds: Bounds = {
  south: 48.8,
  west: 2.2,
  north: 48.9,
  east: 2.4,
};

const geometryHttpRequests: Array<HttpRequest> = [];
const geometryCache = new Map<string, unknown>();
let geometryPayload: unknown = { elements: [] };

const StreetGeometryProviderTest = StreetGeometryProviderLive.pipe(
  Layer.provide(Layer.mergeAll(
    Layer.succeed(RawHttp)({
      json: (request, schema) => {
        geometryHttpRequests.push(request);
        return Schema.decodeUnknownEffect(schema)(geometryPayload).pipe(
          Effect.orDie,
        );
      },
    }),
    Layer.succeed(KVStore)({
      get: (key, schema) => {
        const value = geometryCache.get(key);
        return value === undefined
          ? Effect.succeed(null)
          : Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie);
      },
      set: (key, value) => Effect.sync(() => {
        geometryCache.set(key, value);
      }),
    }),
  )),
);

function resetGeometryProvider(payload: unknown = { elements: [] }): void {
  geometryHttpRequests.length = 0;
  geometryCache.clear();
  geometryPayload = payload;
}

describe("street geometry Overpass helpers", () => {
  it("normalizes accented street names", () => {
    assert.strictEqual(streetKey("  Rue de l'Église "), "RUE DE L'EGLISE");
  });

  it("builds an unrestricted lookup for an empty name list", () => {
    assert.strictEqual(
      buildStreetLookupQuery(bounds, []),
      '[out:json][timeout:6];way["highway"]["name"](48.800000,2.200000,48.900000,2.400000);out tags geom;',
    );
  });

  it("batches name filters and expands accented characters", () => {
    const names = Array.from(
      { length: 37 },
      (_, index) => `RUE EXEMPLE ${index}`,
    );
    const query = buildStreetLookupQuery(bounds, names);

    assert.strictEqual(query.match(/way\[/g)?.length, 2);
    assert.include(query, "[EÈÉÊËèéêë]");
    assert.include(query, `[ ./'’-]+`);
  });

  it("groups valid Overpass ways by normalized name", () => {
    const geometries = streetGeometriesFromPayload({
      elements: [
        {
          type: "way",
          tags: { name: " Rue de l'Église " },
          geometry: [
            { lat: 48.85, lon: 2.35 },
            { lat: 48.851, lon: 2.351 },
          ],
        },
        {
          type: "node",
          tags: { name: "Rue ignorée" },
          geometry: [
            { lat: 48.85, lon: 2.35 },
            { lat: 48.851, lon: 2.351 },
          ],
        },
      ],
    }, "overpass");

    assert.deepEqual(geometries["RUE DE L'EGLISE"], {
      status: "ok",
      source: "overpass",
      osmNames: ["Rue de l'Église"],
      lines: [[
        { lat: 48.85, lng: 2.35 },
        { lat: 48.851, lng: 2.351 },
      ]],
    });
    assert.strictEqual(Object.keys(geometries).length, 1);
  });
});

describe("street geometry batch cache", () => {
  layer(StreetGeometryProviderTest)((it) => {
    it.effect("uses deterministic batch and dedupe keys", () =>
      Effect.gen(function* () {
        resetGeometryProvider({
          elements: [
            {
              type: "way",
              tags: { name: "Rue A" },
              geometry: [
                { lat: 48.85, lon: 2.35 },
                { lat: 48.851, lon: 2.351 },
              ],
            },
            {
              type: "way",
              tags: { name: "Avenue B" },
              geometry: [
                { lat: 48.86, lon: 2.36 },
                { lat: 48.861, lon: 2.361 },
              ],
            },
          ],
        });
        const provider = yield* StreetGeometryProvider;
        const first = [
          { id: "a", name: "Rue A" },
          { id: "b", name: "Avenue B" },
        ];
        const reordered = [
          { id: "b", name: "Avenue B" },
          { id: "a", name: "Rue A" },
        ];

        yield* provider.streetRequestsInBounds(first, bounds);
        yield* provider.streetRequestsInBounds(reordered, bounds);

        const digest =
          "b4788f3364b6e329a8ece0e8235da25e1eef5d290059afad9d0f31c0d8e59044";
        const snappedBounds = "48.7900,2.1800,48.9100,2.4200";
        assert.deepEqual(Array.from(geometryCache.keys()), [
          `streetgeom:batch:${snappedBounds}:${digest}`,
        ]);
        assert.lengthOf(geometryHttpRequests, 1);
        assert.strictEqual(
          geometryHttpRequests[0]?.dedupeKey,
          `${STREET_GEOMETRY_PRIMARY_ENDPOINT}:${snappedBounds}:${digest}`,
        );
        assert.notInclude(
          geometryHttpRequests[0]?.dedupeKey ?? "",
          "AVENUE B",
        );
      }));

    it.effect("keeps request batches immutable", () =>
      Effect.gen(function* () {
        resetGeometryProvider();
        const provider = yield* StreetGeometryProvider;
        const rueA = [{ id: "a", name: "Rue A" }];
        const rueAAndAvenueB = [
          ...rueA,
          { id: "b", name: "Avenue B" },
        ];

        yield* provider.streetRequestsInBounds(rueA, bounds);
        yield* provider.streetRequestsInBounds(rueAAndAvenueB, bounds);
        yield* provider.streetRequestsInBounds(rueA, bounds);

        assert.lengthOf(geometryHttpRequests, 2);
        assert.strictEqual(geometryCache.size, 2);
        assert.isTrue(Array.from(geometryCache.keys()).some((key) =>
          key.endsWith(
            "0730d15b5c769c17b42eff83649ef8a19d240766ef2a055fd83018643eac3451",
          )
        ));
        assert.isTrue(Array.from(geometryCache.keys()).some((key) =>
          key.endsWith(
            "b4788f3364b6e329a8ece0e8235da25e1eef5d290059afad9d0f31c0d8e59044",
          )
        ));
      }));

    it.effect("caches negative misses", () =>
      Effect.gen(function* () {
        resetGeometryProvider();
        const provider = yield* StreetGeometryProvider;
        const requests = [{ id: "missing", name: "Rue absente" }];

        const first = yield* provider.streetRequestsInBounds(requests, bounds);
        const cached = yield* provider.streetRequestsInBounds(requests, bounds);

        assert.strictEqual(first.missing?.status, "miss");
        assert.strictEqual(cached.missing?.status, "miss");
        assert.lengthOf(geometryHttpRequests, 1);
        assert.isTrue(Array.from(geometryCache.keys())[0]?.endsWith(
          "64428b80fcc0232cc09f60ab31e6e87a043293dd7cd6a3127e624425e7363b0e",
        ));
      }));
  });
});

describe("street geometry proximity", () => {
  const nearbyPoint: Position = { lat: 48.85, lng: 2.35 };
  const connectedLine = [
    { lat: 48.85, lng: 2.3512 },
    { lat: 48.85, lng: 2.352 },
  ];
  const disconnectedLine = [
    { lat: 48.85, lng: 2.36 },
    { lat: 48.85, lng: 2.361 },
  ];
  const geometry: StreetGeometry = {
    status: "ok",
    source: "overpass",
    osmNames: ["Rue Exemple"],
    lines: [
      [
        { lat: 48.85, lng: 2.35 },
        { lat: 48.85, lng: 2.351 },
      ],
      connectedLine,
      disconnectedLine,
    ],
  };

  it("keeps the connected component nearest the requested point", () => {
    const filtered = filterStreetGeometryNearPoint(geometry, nearbyPoint);

    assert.strictEqual(filtered.status, "ok");
    if (filtered.status === "ok") {
      assert.deepEqual(filtered.lines, geometry.lines.slice(0, 2));
    }
  });

  it("returns a miss when every component is too far away", () => {
    assert.deepEqual(
      filterStreetGeometryNearPoint(geometry, { lat: 49, lng: 3 }),
      {
        status: "miss",
        query: "",
        updatedAt: "",
        message: "no OSM geometry within 1800m",
      },
    );
  });
});
