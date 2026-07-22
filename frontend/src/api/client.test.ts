import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import type { OutageResponse } from "../../../shared/api.js";
import { fetchOutages } from "./client.js";
import { viewportRequest } from "../map/viewport.js";

const request = viewportRequest({
  south: 48.85,
  west: 2.34,
  north: 48.86,
  east: 2.35,
});

const validResponse: OutageResponse = {
  updatedAt: "2026-03-20T10:00:00.000Z",
  source: {
    enedisEndpoint: "https://example.test/enedis",
    geocoderEndpoint: "https://example.test/geocode",
    geocoderFallbackEndpoint: "https://example.test/geocode-fallback",
    streetGeometryEndpoint: "https://example.test/geometry",
  },
  query: {
    insee: "75056",
    type: "municipality",
    adresse: "Paris",
    CPVille: "Paris 75001",
    name: "Paris",
    district: "",
    city: "Paris",
    department: "75",
  },
  stats: {
    outages: 1,
    addressRows: 1,
    streets: 1,
    geocodedStreets: 1,
    geocodeMisses: 0,
    streetGeometry: 0,
    streetGeometryMisses: 0,
    compteurIncidentHTA: 1,
    compteurTravauxHTA: 0,
    compteurBT: 0,
  },
  outages: [{
    id: "outage-1",
    status: "active",
    type: "Incident HTA",
    etatElectrique: 1,
    codeInsee: "75056",
    dateCoupure: "20/03/2026 09:00",
    dateRealimentation: "20/03/2026 12:00",
    nbFoyersCoupes: 12,
    addresses: [{
      localisation: "Rue de Rivoli, Paris (75001)",
      nbFoyersCoupes: 12,
    }],
  }],
  streets: [{
    key: "RUE DE RIVOLI|75001|PARIS",
    label: "Rue de Rivoli",
    normalizedName: "RUE DE RIVOLI",
    city: "Paris",
    postcode: "75001",
    localisations: ["Rue de Rivoli, Paris (75001)"],
    outageIds: ["outage-1"],
    outageTypes: ["Incident HTA"],
    firstSeenAt: "20/03/2026 09:00",
    estimatedRestoreAt: "20/03/2026 12:00",
    nbFoyersCoupes: 12,
    geocode: {
      status: "ok",
      query: "RUE DE RIVOLI Paris 75001",
      lng: 2.3522,
      lat: 48.8566,
      label: "Rue de Rivoli 75001 Paris",
      type: "street",
      postcode: "75001",
      citycode: "75056",
    },
  }],
  communes: [{ code: "75056", name: "Paris", postcodes: ["75001"] }],
  warnings: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("outage API client", () => {
  it.effect("decodes a valid public response", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Promise<Response> =>
          Promise.resolve(
            new Response(JSON.stringify(validResponse), { status: 200 }),
          )
        ),
      );

      const response = yield* fetchOutages(request);
      assert.strictEqual(response.streets[0]?.label, "Rue de Rivoli");
      assert.strictEqual(response.stats.outages, 1);
    }));

  it.effect("rejects malformed success payloads with a typed decode error", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Promise<Response> =>
          Promise.resolve(
            new Response(JSON.stringify({ updatedAt: "not-enough-fields" }), {
              status: 200,
            }),
          )
        ),
      );

      const error = yield* Effect.flip(fetchOutages(request));
      assert.strictEqual(error._tag, "ApiDecodeError");
      assert.include(error.message, "invalide");
    }));

  it.effect(
    "translates stable API error codes instead of exposing messages",
    () => Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Promise<Response> =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: "RATE_LIMITED",
                message: "too many outage requests",
              }),
              { status: 429 },
            ),
          )
        ),
      );

      const error = yield* Effect.flip(fetchOutages(request));
      assert.strictEqual(error._tag, "ApiStatusError");
      if (error._tag === "ApiStatusError") {
        assert.strictEqual(error.status, 429);
        assert.strictEqual(
          error.message,
          "Trop de requêtes ont été envoyées. Patientez un instant avant de réessayer.",
        );
      }
    }),
  );

  it.effect("uses a localized fallback for unknown API errors", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((): Promise<Response> =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: "FUTURE_ERROR",
                message: "untranslated internal detail",
              }),
              { status: 503 },
            ),
          )
        ),
      );

      const error = yield* Effect.flip(fetchOutages(request));
      assert.strictEqual(error._tag, "ApiStatusError");
      if (error._tag === "ApiStatusError") {
        assert.strictEqual(error.message, "La requête a échoué (HTTP 503).");
      }
    }));
});
