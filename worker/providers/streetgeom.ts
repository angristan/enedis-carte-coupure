import { Clock, Context, Effect, Layer, Schema } from "effect";
import {
  type UpstreamError,
  UpstreamTransportError,
} from "../domain/errors.js";
import { type Bounds, boundsCacheKey, padded, snapped } from "../domain/geo.js";
import {
  OverpassPayloadSchema,
  type StreetGeometry,
  type StreetGeometryResults,
  StreetGeometrySchema,
  type StreetRequest,
} from "../domain/models.js";
import { RawHttp } from "../platform/http.js";
import { KVStore } from "../platform/kv.js";
import { filterStreetGeometryNearPoint } from "./streetgeom-geometry.js";
import {
  buildStreetLookupQuery,
  streetGeometriesFromPayload,
  streetKey,
} from "./streetgeom-overpass.js";
import { sha256Hex, uniqueSorted } from "../domain/util.js";
import {
  STREET_GEOMETRY_FALLBACK_ENDPOINT,
  STREET_GEOMETRY_PRIMARY_ENDPOINT,
} from "../sources.js";

export { streetKey } from "./streetgeom-overpass.js";

const VIEWPORT_PADDING_RATIO = 0.08;
const VIEWPORT_SNAP_GRID = 0.005;
const BATCH_CACHE_TTL = 3600;
const BATCH_TTL = 24 * 60 * 60;

const BoundsSchema = Schema.Struct({
  south: Schema.Number,
  west: Schema.Number,
  north: Schema.Number,
  east: Schema.Number,
});

const GeometryBatchSchema = Schema.Struct({
  version: Schema.Literal(5),
  updatedAt: Schema.String,
  bounds: BoundsSchema,
  streets: Schema.Record(Schema.String, StreetGeometrySchema),
});

type GeometryBatch = Schema.Schema.Type<typeof GeometryBatchSchema>;

export class StreetGeometryProvider
  extends Context.Service<StreetGeometryProvider, {
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
        namesDigest: string,
      ) {
        const form = new URLSearchParams();
        form.set("data", buildStreetLookupQuery(bounds, nameKeys));

        const payload = yield* http.json({
          provider: "Overpass",
          operation: "streetgeom.lookup",
          url: endpoint,
          dedupeKey:
            `${endpoint}:${boundsCacheKey(bounds)}:${namesDigest}`,
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
      namesDigest: string,
    ): Effect.Effect<Readonly<Record<string, StreetGeometry>>, UpstreamError> =>
      lookup(
        STREET_GEOMETRY_PRIMARY_ENDPOINT,
        bounds,
        nameKeys,
        namesDigest,
      ).pipe(
        Effect.catch((error) =>
          error._tag === "UpstreamStatusError" && error.status === 429
            ? Effect.fail(error)
            : lookup(
              STREET_GEOMETRY_FALLBACK_ENDPOINT,
              bounds,
              nameKeys,
              namesDigest,
            )
        ),
      );

    const forBatch = Effect.fn("StreetGeometry.forBatch")(
      function* (
        requests: ReadonlyArray<StreetRequest>,
        bounds: Bounds,
      ) {
        const requested = collectStreetRequests(requests);
        if (requested.size === 0) return {};

        const nameKeys = collectStreetKeys(requested);
        const namesDigest = yield* sha256Hex(JSON.stringify(nameKeys)).pipe(
          Effect.mapError((error) =>
            UpstreamTransportError.make({
              provider: "Overpass",
              operation: "streetgeom.batch-key",
              cause: error.cause,
            })
          ),
        );
        const cacheKey =
          `streetgeom:batch:${boundsCacheKey(bounds)}:${namesDigest}`;
        const cached = yield* cache
          .get(cacheKey, GeometryBatchSchema, BATCH_CACHE_TTL)
          .pipe(
            Effect.catchTag("CacheError", () => Effect.succeed(null)),
          );

        if (cached !== null) return geometryResults(requested, cached);

        const geometries = yield* fetchGeometry(bounds, nameKeys, namesDigest);
        const now = yield* Clock.currentTimeMillis;
        const batch = makeGeometryBatch(
          bounds,
          nameKeys,
          geometries,
          new Date(now).toISOString(),
        );

        yield* cache.set(cacheKey, batch, BATCH_TTL).pipe(
          Effect.catchTag("CacheError", () => Effect.void),
        );

        return geometryResults(requested, batch);
      },
    );

    return {
      streetRequestsInBounds: (requests, bounds) =>
        forBatch(
          requests,
          snapped(
            padded(bounds, VIEWPORT_PADDING_RATIO),
            VIEWPORT_SNAP_GRID,
          ),
        ),
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

function collectStreetKeys(
  requested: ReadonlyMap<string, StreetRequest>,
): ReadonlyArray<string> {
  return uniqueSorted(
    Array.from(requested.values(), (request) => streetKey(request.name)),
  );
}

function makeGeometryBatch(
  bounds: Bounds,
  nameKeys: ReadonlyArray<string>,
  geometries: Readonly<Record<string, StreetGeometry>>,
  updatedAt: string,
): GeometryBatch {
  const streets: Record<string, StreetGeometry> = {};

  for (const key of nameKeys) {
    streets[key] = geometries[key] ?? {
      status: "miss",
      query: key,
      updatedAt,
    };
  }

  return {
    version: 5,
    updatedAt,
    bounds,
    streets,
  };
}

function geometryResults(
  requested: ReadonlyMap<string, StreetRequest>,
  batch: GeometryBatch,
): StreetGeometryResults {
  const results: Record<string, StreetGeometry> = {};

  for (const [resultKey, request] of requested) {
    const found = batch.streets[streetKey(request.name)] ?? {
      status: "miss",
      query: request.name,
      updatedAt: batch.updatedAt,
    };
    const named: StreetGeometry = { ...found, query: request.name };

    results[resultKey] = request.point === undefined
      ? named
      : filterStreetGeometryNearPoint(named, request.point);
  }

  return results;
}
