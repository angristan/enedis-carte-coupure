import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { UpstreamError } from "./errors.js";
import { type Bounds, boundsCacheKey, padded, snapped } from "./geo.js";
import {
  OverpassPayloadSchema,
  type StreetGeometry,
  type StreetGeometryResults,
  StreetGeometrySchema,
  type StreetRequest,
} from "./models.js";
import { KVStore, RawHttp } from "./platform.js";
import { filterStreetGeometryNearPoint } from "./streetgeom-geometry.js";
import {
  buildStreetLookupQuery,
  streetGeometriesFromPayload,
  streetKey,
} from "./streetgeom-overpass.js";
import { uniqueSorted } from "./util.js";

export const STREET_GEOMETRY_PRIMARY_ENDPOINT =
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
export const STREET_GEOMETRY_FALLBACK_ENDPOINT =
  "https://lz4.overpass-api.de/api/interpreter";

export { streetKey } from "./streetgeom-overpass.js";

const VIEWPORT_PADDING_RATIO = 0.08;
const VIEWPORT_SNAP_GRID = 0.005;
const INDEX_CACHE_TTL = 3600;
const INDEX_TTL = 24 * 60 * 60;

const DEFAULT_BOUNDS: Bounds = {
  south: 48.815,
  west: 2.224,
  north: 48.902,
  east: 2.47,
};

const BoundsSchema = Schema.Struct({
  south: Schema.Number,
  west: Schema.Number,
  north: Schema.Number,
  east: Schema.Number,
});

const IndexSchema = Schema.Struct({
  version: Schema.Literal(4),
  updatedAt: Schema.String,
  source: Schema.String,
  bounds: BoundsSchema,
  streets: Schema.Record(Schema.String, StreetGeometrySchema),
});

type Index = Schema.Schema.Type<typeof IndexSchema>;

export class StreetGeometryProvider
  extends Context.Service<StreetGeometryProvider, {
    readonly streetRequests: (
      requests: ReadonlyArray<StreetRequest>,
    ) => Effect.Effect<StreetGeometryResults, UpstreamError>;
    readonly streetRequestsInBounds: (
      requests: ReadonlyArray<StreetRequest>,
      bounds: Bounds,
    ) => Effect.Effect<StreetGeometryResults, UpstreamError>;
  }>()("StreetGeometryProvider") {}

export const StreetGeometryProviderLive = Layer.effect(StreetGeometryProvider)(
  Effect.gen(function* () {
    const http = yield* RawHttp;
    const cache = yield* KVStore;

    const lookup = Effect.fn("StreetGeometry.lookup")(
      function* (
        endpoint: string,
        bounds: Bounds,
        nameKeys: ReadonlyArray<string>,
      ) {
        const form = new URLSearchParams();
        form.set("data", buildStreetLookupQuery(bounds, nameKeys));

        const payload = yield* http.json({
          provider: "Overpass",
          operation: "streetgeom.lookup",
          url: endpoint,
          attributes: {
            "streetgeom.endpoint": endpoint,
            "streetgeom.names": nameKeys.length,
          },
          init: {
            method: "POST",
            body: form,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "enedis-carte-coupure/1.0",
            },
          },
        }, OverpassPayloadSchema);

        return streetGeometriesFromPayload(payload, endpoint);
      },
    );

    const fetchGeometry = (
      bounds: Bounds,
      nameKeys: ReadonlyArray<string>,
    ): Effect.Effect<Readonly<Record<string, StreetGeometry>>, UpstreamError> =>
      lookup(STREET_GEOMETRY_PRIMARY_ENDPOINT, bounds, nameKeys).pipe(
        Effect.catch(() =>
          lookup(STREET_GEOMETRY_FALLBACK_ENDPOINT, bounds, nameKeys)
        ),
      );

    const forIndex = Effect.fn("StreetGeometry.forIndex")(
      function* (
        requests: ReadonlyArray<StreetRequest>,
        bounds: Bounds,
        indexKey: string,
      ) {
        const requested = collectStreetRequests(requests);
        if (requested.size === 0) return {};

        const cacheKey = `streetgeom:${indexKey}`;
        const cached = yield* cache
          .get(cacheKey, IndexSchema, INDEX_CACHE_TTL)
          .pipe(
            Effect.catchTag("CacheError", () => Effect.succeed(null)),
          );
        const missing = missingStreetKeys(requested, cached);

        let index = cached ?? emptyIndex(bounds);

        if (missing.length > 0) {
          const geometries = yield* fetchGeometry(bounds, missing);
          const now = yield* Clock.currentTimeMillis;
          const updatedAt = new Date(now).toISOString();

          index = updateIndex(index, bounds, missing, geometries, updatedAt);

          yield* cache.set(cacheKey, index, INDEX_TTL).pipe(
            Effect.catchTag("CacheError", () => Effect.void),
          );
        }

        return geometryResults(requested, index);
      },
    );

    return {
      streetRequests: (requests) => forIndex(requests, DEFAULT_BOUNDS, "paris"),
      streetRequestsInBounds: (requests, bounds) => {
        const indexBounds = snapped(
          padded(bounds, VIEWPORT_PADDING_RATIO),
          VIEWPORT_SNAP_GRID,
        );

        return forIndex(
          requests,
          indexBounds,
          `streets:${boundsCacheKey(indexBounds)}`,
        );
      },
    };
  }),
);

function collectStreetRequests(
  requests: ReadonlyArray<StreetRequest>,
): Map<string, StreetRequest> {
  const requested = new Map<string, StreetRequest>();

  for (const request of requests) {
    const name = request.name.trim();
    const key = streetKey(name);

    if (key.length > 0) {
      requested.set(request.id.trim() || key, { ...request, name });
    }
  }

  return requested;
}

function missingStreetKeys(
  requested: ReadonlyMap<string, StreetRequest>,
  cached: Index | null,
): ReadonlyArray<string> {
  return uniqueSorted(
    Array.from(requested.values(), (request) => streetKey(request.name))
      .filter((key) => cached?.streets[key] === undefined),
  );
}

function emptyIndex(bounds: Bounds): Index {
  return {
    version: 4,
    updatedAt: "",
    source: "",
    bounds,
    streets: {},
  };
}

function updateIndex(
  current: Index,
  bounds: Bounds,
  missing: ReadonlyArray<string>,
  geometries: Readonly<Record<string, StreetGeometry>>,
  updatedAt: string,
): Index {
  const streets: Record<string, StreetGeometry> = { ...current.streets };

  for (const key of missing) {
    streets[key] = geometries[key] ?? {
      status: "miss",
      query: key,
      updatedAt,
    };
  }

  return {
    version: 4,
    updatedAt,
    source: STREET_GEOMETRY_PRIMARY_ENDPOINT,
    bounds,
    streets,
  };
}

function geometryResults(
  requested: ReadonlyMap<string, StreetRequest>,
  index: Index,
): StreetGeometryResults {
  const results: Record<string, StreetGeometry> = {};

  for (const [resultKey, request] of requested) {
    const found = index.streets[streetKey(request.name)] ?? {
      status: "miss",
      query: request.name,
      updatedAt: index.updatedAt,
    };
    const named: StreetGeometry = { ...found, query: request.name };

    results[resultKey] = request.point === undefined
      ? named
      : filterStreetGeometryNearPoint(named, request.point);
  }

  return results;
}
