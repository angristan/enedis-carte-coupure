import { Clock, Context, Effect, Layer, Schema } from "effect";
import { TooManyCommunes, type UpstreamError } from "./errors.js";
import {
  type Bounds,
  boundsCacheKey,
  boundsFromGeoJSONGeometry,
  padded,
  snapped,
} from "./geo.js";
import { type Commune, CommuneSchema, type EnedisQuery } from "./models.js";
import { KVStore, RawHttp, WorkerConfig } from "./platform.js";

export const COMMUNES_ENDPOINT =
  "https://apicarto.ign.fr/api/limites-administratives/commune";
const VIEWPORT_GRID = 0.0001;
const GEOMETRY_PADDING_RATIO = 0.04;
const API_CARTO_MAXIMUM = 500;

const ApiCommuneGeometrySchema = Schema.Struct({
  type: Schema.String,
  coordinates: Schema.Unknown,
});

const ApiCommuneFeatureSchema = Schema.Struct({
  type: Schema.Literal("Feature"),
  geometry: Schema.NullOr(ApiCommuneGeometrySchema),
  properties: Schema.Struct({
    nom_com: Schema.String,
    insee_com: Schema.String,
    code_postal: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const ApiCommunesSchema = Schema.Struct({
  type: Schema.Literal("FeatureCollection"),
  features: Schema.Array(ApiCommuneFeatureSchema),
});

const CachedCommunesSchema = Schema.Struct({
  version: Schema.Literal(4),
  updatedAt: Schema.String,
  bounds: Schema.Struct({
    south: Schema.Number,
    west: Schema.Number,
    north: Schema.Number,
    east: Schema.Number,
  }),
  communes: Schema.Array(CommuneSchema),
});

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

    const forBounds = Effect.fn("CommuneDirectory.forBounds")(
      function* (bounds: Bounds, maximum: number) {
        const cacheBounds = snapped(bounds, VIEWPORT_GRID);
        const cacheKey = `communes:${boundsCacheKey(cacheBounds)}`;
        const cached = yield* cache.get(cacheKey, CachedCommunesSchema, 3600)
          .pipe(Effect.catchTag("CacheError", () => Effect.succeed(null)));
        if (cached !== null) {
          return cached.communes;
        }

        const url = new URL(COMMUNES_ENDPOINT);
        url.searchParams.set("geom", JSON.stringify(boundsPolygon(cacheBounds)));
        url.searchParams.set(
          "_limit",
          String(
            maximum > 0
              ? Math.min(maximum + 1, API_CARTO_MAXIMUM)
              : API_CARTO_MAXIMUM,
          ),
        );
        const decoded = yield* http.json({
          provider: "communes",
          operation: "communes.intersect",
          url,
          attributes: {
            "geo.south": cacheBounds.south,
            "geo.west": cacheBounds.west,
            "geo.north": cacheBounds.north,
            "geo.east": cacheBounds.east,
          },
          init: {
            headers: {
              Accept: "application/json",
              "User-Agent": "enedis-carte-coupure/1.0",
            },
          },
        }, ApiCommunesSchema);

        if (maximum > 0 && decoded.features.length > maximum) {
          return yield* TooManyCommunes.make({
            maximum,
            message: `viewport covers more than ${maximum} communes; zoom in`,
          });
        }

        const seen = new Map<string, Commune>();
        for (const feature of decoded.features) {
          const properties = feature.properties;
          if (seen.has(properties.insee_com)) continue;
          const contour = feature.geometry;
          const contourBounds = boundsFromGeoJSONGeometry(contour);
          seen.set(properties.insee_com, {
            name: properties.nom_com,
            code: properties.insee_com,
            postcodes: properties.code_postal === null ||
                properties.code_postal === undefined
              ? []
              : [properties.code_postal],
            ...(contourBounds === null ? {} : {
              center: {
                type: "Point",
                coordinates: [
                  (contourBounds.west + contourBounds.east) / 2,
                  (contourBounds.south + contourBounds.north) / 2,
                ],
              },
            }),
            ...(contour === null ? {} : { contour }),
          });
        }

        const communes = Array.from(seen.values()).sort((left, right) =>
          left.code.localeCompare(right.code)
        );

        const now = yield* Clock.currentTimeMillis;
        yield* cache.set(cacheKey, {
          version: 4,
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

function boundsPolygon(bounds: Bounds) {
  return {
    type: "Polygon",
    coordinates: [[
      [bounds.west, bounds.south],
      [bounds.east, bounds.south],
      [bounds.east, bounds.north],
      [bounds.west, bounds.north],
      [bounds.west, bounds.south],
    ]],
  };
}

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
