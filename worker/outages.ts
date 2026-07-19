import { Clock, Context, Effect, Layer } from "effect";
import type { UpstreamError } from "./errors.js";
import type { Bounds } from "./geo.js";
import { Geocoder, publicGeocode } from "./geocode.js";
import type {
  EnedisQuery,
  NormalizeInput,
  OutageResponse,
  Street,
  StreetRequest,
} from "./models.js";
import {
  normalizeOutageInputs,
  refreshStreetStats,
} from "./outage-response.js";
import { StreetGeometryProvider, streetKey } from "./streetgeom.js";

export { mergeOutageResponses } from "./outage-merging.js";
export { responseCommunes } from "./outage-response.js";
export { normalizeStreet, parseLocalisation } from "./street-normalization.js";

const MAX_GEOCODE_CONCURRENCY = 4;

interface NormalizeOptions {
  readonly geocode: boolean;
  readonly geometry: boolean;
  readonly geometryBounds?: Bounds;
}

export class Normalizer extends Context.Service<Normalizer, {
  readonly normalize: (
    raw: NormalizeInput["raw"],
    query: EnedisQuery,
    geocode: boolean,
  ) => Effect.Effect<OutageResponse, UpstreamError>;
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
    function* (streets: ReadonlyArray<Street>, bounds?: Bounds) {
      if (streets.length === 0) {
        return streets;
      }

      const requests = streets.map(streetGeometryRequest);
      const results = yield* (bounds === undefined
        ? geometries.streetRequests(requests)
        : geometries.streetRequestsInBounds(requests, bounds));

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
      response = withStreets(response, geocodedStreets);

      if (options.geometry) {
        const streetsWithGeometry = yield* attachStreetGeometry(
          geocodedStreets,
          options.geometryBounds,
        );
        response = withStreets(response, streetsWithGeometry);
      }

      return response;
    },
  );

  const attachGeometry = Effect.fn("Normalizer.attachGeometry")(
    function* (response: OutageResponse, bounds: Bounds) {
      const streets = yield* attachStreetGeometry(response.streets, bounds);

      return withStreets(response, streets);
    },
  );

  return {
    normalize: (raw, query, geocode) =>
      normalizeSet([{ raw, query }], { geocode, geometry: geocode }),
    normalizeSet,
    attachGeometry,
  };
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
