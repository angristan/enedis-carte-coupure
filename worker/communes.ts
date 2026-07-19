import { Clock, Context, Effect, Layer, Schema } from "effect";
import { TooManyCommunes, type UpstreamError } from "./errors.js";
import {
  type Bounds,
  boundsCacheKey,
  boundsFromGeoJSONGeometry,
  center,
  padded,
  type Position,
  snapped,
} from "./geo.js";
import { type Commune, CommuneSchema, type EnedisQuery } from "./models.js";
import { KVStore, RawHttp, WorkerConfig } from "./platform.js";

export const COMMUNES_ENDPOINT = "https://geo.api.gouv.fr/communes";
const LOOKUP_CONCURRENCY = 8;
const VIEWPORT_GRID = 0.02;
const GEOMETRY_PADDING_RATIO = 0.04;

const ApiCommuneSchema = Schema.Struct({
  nom: Schema.String,
  code: Schema.String,
  codesPostaux: Schema.optionalKey(Schema.Array(Schema.String)),
  centre: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      coordinates: Schema.Tuple([Schema.Number, Schema.Number]),
    }),
  ),
  contour: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ type: Schema.String, coordinates: Schema.Unknown }),
    ),
  ),
});
const ApiCommunesSchema = Schema.Array(ApiCommuneSchema);

const CachedCommunesSchema = Schema.Struct({
  version: Schema.Literal(3),
  updatedAt: Schema.String,
  bounds: Schema.Struct({
    south: Schema.Number,
    west: Schema.Number,
    north: Schema.Number,
    east: Schema.Number,
  }),
  communes: Schema.Array(CommuneSchema),
});

type LookupResult = { readonly ok: true; readonly commune: Commune | null } | {
  readonly ok: false;
  readonly error: UpstreamError;
};

export class CommuneDirectory extends Context.Service<CommuneDirectory, {
  readonly forBounds: (
    bounds: Bounds,
    maximum: number,
  ) => Effect.Effect<ReadonlyArray<Commune>, TooManyCommunes | UpstreamError>;
}>()("CommuneDirectory") {}

export const CommuneDirectoryLive = Layer.effect(CommuneDirectory)(
  Effect.gen(function* () {
    const http = yield* RawHttp;
    const cache = yield* KVStore;
    const config = yield* WorkerConfig;

    const lookupPoint = Effect.fn("CommuneDirectory.lookupPoint")(
      function* (point: Position) {
        const url = new URL(COMMUNES_ENDPOINT);
        url.searchParams.set("lat", point.lat.toFixed(6));
        url.searchParams.set("lon", point.lng.toFixed(6));
        url.searchParams.set("fields", "nom,code,codesPostaux,centre,contour");
        url.searchParams.set("format", "json");
        const decoded = yield* http.json({
          provider: "communes",
          operation: "communes.lookup",
          url,
          attributes: { "geo.lat": point.lat, "geo.lng": point.lng },
          init: {
            headers: {
              Accept: "application/json",
              "User-Agent": "enedis-carte-coupure/1.0",
            },
          },
        }, ApiCommunesSchema);
        const first = decoded[0];
        if (first === undefined) return null;

        return {
          name: first.nom,
          code: first.code,
          postcodes: first.codesPostaux ?? [],
          ...(first.centre === undefined ? {} : { center: first.centre }),
          ...(first.contour === undefined ? {} : { contour: first.contour }),
        } satisfies Commune;
      },
    );

    const forBounds = Effect.fn("CommuneDirectory.forBounds")(
      function* (bounds: Bounds, maximum: number) {
        const cacheBounds = snapped(bounds, VIEWPORT_GRID);
        const cacheKey = `communes:${boundsCacheKey(cacheBounds)}`;
        const cached = yield* cache.get(cacheKey, CachedCommunesSchema, 3600)
          .pipe(Effect.catchTag("CacheError", () => Effect.succeed(null)));
        if (cached !== null) {
          return cached.communes;
        }

        const results = yield* Effect.forEach(
          samplePoints(bounds),
          (point): Effect.Effect<LookupResult> =>
            lookupPoint(point).pipe(
              Effect.map((commune) =>
                ({ ok: true, commune }) satisfies LookupResult
              ),
              Effect.catch((error) =>
                Effect.succeed({ ok: false, error } satisfies LookupResult)
              ),
            ),
          { concurrency: LOOKUP_CONCURRENCY },
        );

        const seen = new Map<string, Commune>();
        let lastError: UpstreamError | undefined;
        for (const result of results) {
          if ("error" in result) {
            lastError = result.error;
            continue;
          }
          if (result.commune !== null && !seen.has(result.commune.code)) {
            seen.set(result.commune.code, result.commune);
          }
        }

        if (maximum > 0 && seen.size > maximum) {
          return yield* TooManyCommunes.make({
            maximum,
            message: `viewport covers more than ${maximum} communes; zoom in`,
          });
        }

        const communes = Array.from(seen.values()).sort((left, right) =>
          left.code.localeCompare(right.code)
        );
        if (communes.length === 0 && lastError !== undefined) {
          return yield* lastError;
        }

        const now = yield* Clock.currentTimeMillis;
        yield* cache.set(cacheKey, {
          version: 3,
          updatedAt: new Date(now).toISOString(),
          bounds: cacheBounds,
          communes,
        }, config.communesCacheTtl).pipe(
          Effect.catchTag("CacheError", () => Effect.void),
        );
        return communes;
      },
    );

    return { forBounds };
  }),
);

function samplePoints(bounds: Bounds): ReadonlyArray<Position> {
  const points: Array<Position> = [center(bounds)];
  const seen = new Set([pointKey(points[0])]);
  const grid = 3;
  for (let latIndex = 0; latIndex < grid; latIndex += 1) {
    for (let lngIndex = 0; lngIndex < grid; lngIndex += 1) {
      const point = {
        lat: interpolate(bounds.south, bounds.north, latIndex, grid),
        lng: interpolate(bounds.west, bounds.east, lngIndex, grid),
      };
      const key = pointKey(point);
      if (!seen.has(key)) {
        seen.add(key);
        points.push(point);
      }
    }
  }

  return points;
}

const interpolate = (
  min: number,
  max: number,
  index: number,
  count: number,
): number =>
  count <= 1 ? (min + max) / 2 : min + ((max - min) * index) / (count - 1);
const pointKey = (point: Position): string =>
  `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;

export function enedisQueryForCommune(commune: Commune): EnedisQuery {
  const postcode = commune.postcodes[0] ?? "";
  const centerCoordinates = commune.center?.coordinates;
  return {
    insee: commune.code,
    type: "municipality",
    adresse: commune.name,
    CPVille: `${commune.name} ${postcode}`.trim(),
    name: commune.name,
    district: "",
    city: commune.name,
    department: departmentFromCode(commune.code),
    ...(centerCoordinates === undefined ? {} : {
      longitude: centerCoordinates[0].toFixed(6),
      latitude: centerCoordinates[1].toFixed(6),
    }),
  };
}

function departmentFromCode(code: string): string {
  return code.length >= 3 && (code.startsWith("97") || code.startsWith("98"))
    ? code.slice(0, 3)
    : code.slice(0, 2);
}

export function boundsForCommune(
  commune: Commune,
  fallbackBounds?: Bounds,
): Bounds | undefined {
  const contourBounds = boundsFromGeoJSONGeometry(commune.contour);
  if (contourBounds !== null) {
    return padded(contourBounds, GEOMETRY_PADDING_RATIO);
  }
  if (fallbackBounds !== undefined) return fallbackBounds;

  const coordinates = commune.center?.coordinates;
  if (coordinates === undefined) return undefined;

  return {
    south: coordinates[1] - 0.03,
    west: coordinates[0] - 0.03,
    north: coordinates[1] + 0.03,
    east: coordinates[0] + 0.03,
  };
}
