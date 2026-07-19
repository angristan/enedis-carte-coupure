import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { GeocodeResult, PublicGeocode } from "./models.js";
import { GeocodePayloadSchema } from "./models.js";
import { KVStore, RawHttp } from "./platform.js";
import { stripAccents } from "./util.js";

export const GEOCODE_PRIMARY_ENDPOINT =
  "https://data.geopf.fr/geocodage/search";
export const GEOCODE_FALLBACK_ENDPOINT =
  "https://api-adresse.data.gouv.fr/search/";

const GEOCODE_TTL_SECONDS = 30 * 24 * 60 * 60;

const CachedGeocodeSchema = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.String,
  result: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("ok"),
      query: Schema.String,
      lng: Schema.Number,
      lat: Schema.Number,
      label: Schema.String,
      score: Schema.optionalKey(Schema.Number),
      type: Schema.String,
      postcode: Schema.String,
      citycode: Schema.String,
    }),
    Schema.Struct({ status: Schema.Literal("miss"), query: Schema.String }),
  ]),
});

export class Geocoder extends Context.Service<Geocoder, {
  readonly street: (query: string) => Effect.Effect<GeocodeResult>;
}>()("Geocoder") {}

export const GeocoderLive = Layer.effect(Geocoder)(Effect.gen(function* () {
  const http = yield* RawHttp;
  const cache = yield* KVStore;

  const lookup = Effect.fn("Geocoder.lookup")(
    function* (endpoint: string, query: string) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "1");

      const decoded = yield* http.json({
        provider: "geocoder",
        operation: "geocode.lookup",
        url,
        attributes: { "geocode.endpoint": endpoint },
        init: {
          headers: {
            Accept: "application/json",
            "User-Agent": "enedis-carte-coupure/1.0",
          },
        },
      }, GeocodePayloadSchema);
      const feature = decoded.features?.[0];

      if (feature === undefined) {
        return { status: "miss", query } satisfies PublicGeocode;
      }

      const properties = feature.properties;

      return {
        status: "ok",
        query,
        lng: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1],
        label: properties?.label ?? "",
        ...(properties?.score === undefined ? {} : { score: properties.score }),
        type: properties?.type ?? "",
        postcode: properties?.postcode ?? "",
        citycode: properties?.citycode ?? "",
      } satisfies PublicGeocode;
    },
  );

  const street = Effect.fn("Geocoder.street")(function* (rawQuery: string) {
    const query = rawQuery.trim();
    const key = `geocode:${geocodeKey(query).slice(0, 400)}`;

    const cached = yield* cache.get(key, CachedGeocodeSchema, 3600).pipe(
      Effect.catchTag("CacheError", () => Effect.succeed(null)),
    );
    if (cached !== null) {
      return { ...cached.result, cached: true } satisfies GeocodeResult;
    }

    const fallback = lookup(GEOCODE_FALLBACK_ENDPOINT, query);
    const result = yield* lookup(GEOCODE_PRIMARY_ENDPOINT, query).pipe(
      Effect.flatMap((primary) =>
        primary.status === "ok" ? Effect.succeed(primary) : fallback
      ),
      Effect.catch(() => fallback),
      Effect.catch((error) =>
        Effect.succeed(
          {
            status: "error",
            query,
            message: `${error.provider} lookup failed`,
          } satisfies PublicGeocode,
        )
      ),
    );
    if (result.status !== "error") {
      const now = yield* Clock.currentTimeMillis;
      yield* cache.set(key, {
        version: 1,
        updatedAt: new Date(now).toISOString(),
        result,
      }, GEOCODE_TTL_SECONDS).pipe(
        Effect.catchTag("CacheError", () => Effect.void),
      );
    }

    return { ...result, cached: false } satisfies GeocodeResult;
  });

  return { street };
}));

export function geocodeKey(query: string): string {
  return stripAccents(query.trim()).toUpperCase();
}

export function publicGeocode(result: GeocodeResult): PublicGeocode {
  if (result.status === "ok") {
    return {
      status: "ok",
      query: result.query,
      lng: result.lng,
      lat: result.lat,
      label: result.label,
      ...(result.score === undefined ? {} : { score: result.score }),
      type: result.type,
      postcode: result.postcode,
      citycode: result.citycode,
    };
  }

  return result.status === "miss"
    ? { status: "miss", query: result.query }
    : { status: "error", query: result.query, message: result.message };
}
