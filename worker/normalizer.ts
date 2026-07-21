import { Clock, Context, Effect, Layer } from "effect";
import type { UpstreamError } from "./domain/errors.js";
import type { Bounds } from "./domain/geo.js";
import { Geocoder, publicGeocode } from "./providers/geocode.js";
import type {
  NormalizeInput,
  OutageResponse,
  Street,
  StreetRequest,
} from "./domain/models.js";
import {
  normalizeOutageInputs,
  refreshStreetStats,
} from "./domain/outage-response.js";
import { StreetGeometryProvider, streetKey } from "./providers/streetgeom.js";

export { mergeOutageResponses } from "./domain/outage-merging.js";
export { responseCommunes } from "./domain/outage-response.js";
export { normalizeStreet, parseLocalisation } from "./domain/street-normalization.js";

const MAX_GEOCODE_CONCURRENCY = 4;

interface NormalizeOptions {
  readonly geocode: boolean;
}

export class Normalizer extends Context.Service<Normalizer, {
  readonly normalizeSet: (
    inputs: ReadonlyArray<NormalizeInput>,
    options: NormalizeOptions,
  ) => Effect.Effect<OutageResponse, UpstreamError>;
  readonly attachGeometry: (
    response: OutageResponse,
    bounds: Bounds,
  ) => Effect.Effect<OutageResponse, UpstreamError>;
}>()("Normalizer") {}

export const NormalizerLive = Layer.effect(Normalizer)(Effect.gen(function* () {
  const geocoder = yield* Geocoder;
  const geometries = yield* StreetGeometryProvider;

  const attachStreetGeometry = Effect.fn("Normalizer.attachStreetGeometry")(
    function* (streets: ReadonlyArray<Street>, bounds: Bounds) {
      if (streets.length === 0) {
        return streets;
      }

      const requests = streets.map(streetGeometryRequest);
      const results = yield* geometries.streetRequestsInBounds(
        requests,
        bounds,
      );

      return streets.map((street) => {
        const geometry = results[street.key] ??
          results[streetKey(street.normalizedName)];

        return geometry === undefined ? street : { ...street, geometry };
      });
    },
  );

  const geocodeStreets = Effect.fn("Normalizer.geocodeStreets")(
    function* (streets: ReadonlyArray<Street>) {
      return yield* Effect.forEach(
        streets,
        (street) =>
          Effect.gen(function* () {
            const query = [
              street.normalizedName,
              street.city,
              street.postcode,
            ].join(" ").trim();
            const result = yield* geocoder.street(query);

            if (!result.cached) {
              yield* Effect.sleep("120 millis");
            }

            return { ...street, geocode: publicGeocode(result) };
          }),
        { concurrency: MAX_GEOCODE_CONCURRENCY },
      );
    },
  );

  const normalizeSet = Effect.fn("Normalizer.normalizeSet")(
    function* (
      inputs: ReadonlyArray<NormalizeInput>,
      options: NormalizeOptions,
    ) {
      const now = yield* Clock.currentTimeMillis;
      let response = normalizeOutageInputs(
        inputs,
        new Date(now).toISOString(),
      );

      if (!options.geocode || response.streets.length === 0) {
        return response;
      }

      const geocodedStreets = yield* geocodeStreets(response.streets);
      return withStreets(response, geocodedStreets);
    },
  );

  const attachGeometry = Effect.fn("Normalizer.attachGeometry")(
    function* (response: OutageResponse, bounds: Bounds) {
      const streets = yield* attachStreetGeometry(response.streets, bounds);

      return withStreets(response, streets);
    },
  );

  return { normalizeSet, attachGeometry };
}));

function streetGeometryRequest(street: Street): StreetRequest {
  if (street.geocode?.status !== "ok") {
    return {
      id: street.key,
      name: street.normalizedName,
    };
  }

  return {
    id: street.key,
    name: street.normalizedName,
    point: {
      lat: street.geocode.lat,
      lng: street.geocode.lng,
    },
  };
}

function withStreets(
  response: OutageResponse,
  streets: ReadonlyArray<Street>,
): OutageResponse {
  return {
    ...response,
    streets,
    stats: refreshStreetStats(response.stats, streets),
  };
}
