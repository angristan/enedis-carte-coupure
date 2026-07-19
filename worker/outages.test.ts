import { assert, describe, it } from "@effect/vitest";
import type { OutageResponse } from "../shared/api.js";
import {
  mergeOutageResponses,
  normalizeStreet,
  parseLocalisation,
} from "./outages.js";

function response(
  polygon: unknown,
  recap?: unknown,
  crises?: unknown,
): OutageResponse {
  return {
    updatedAt: "2026-03-20T10:00:00.000Z",
    source: {
      enedisEndpoint: "enedis",
      geocoderEndpoint: "geocoder",
      geocoderFallbackEndpoint: "geocoder-fallback",
      streetGeometryEndpoint: "geometry",
    },
    query: {
      insee: "75056",
      type: "municipality",
      adresse: "Paris",
      CPVille: "Paris 75001",
      name: "Paris",
      district: "",
      city: "Paris",
    },
    polygon,
    stats: {
      outages: 0,
      addressRows: 0,
      streets: 0,
      geocodedStreets: 0,
      geocodeMisses: 0,
      streetGeometry: 0,
      streetGeometryMisses: 0,
      compteurIncidentHTA: 0,
      compteurTravauxHTA: 0,
      compteurBT: 0,
    },
    outages: [],
    streets: [],
    ...(recap === undefined ? {} : { recap }),
    ...(crises === undefined ? {} : { crises }),
  };
}

describe("outage street parsing", () => {
  it("normalizes abbreviations and address numbers", () => {
    assert.strictEqual(
      normalizeStreet("12 R. de Longchamp"),
      "RUE DE LONGCHAMP",
    );
    assert.strictEqual(
      normalizeStreet("BD Saint-Michel"),
      "BOULEVARD SAINT-MICHEL",
    );
  });
  it("extracts city and postcode", () => {
    assert.deepEqual(
      parseLocalisation("R. de Longchamp, PARIS 16 (75116)", "Paris"),
      {
        label: "Rue de Longchamp",
        normalizedName: "RUE DE LONGCHAMP",
        normalizedKey: "RUE DE LONGCHAMP",
        city: "Paris 16",
        postcode: "75116",
      },
    );
  });

  it("combines commune polygons and summary data", () => {
    const firstPolygon = {
      type: "Polygon",
      coordinates: [[[2, 48], [3, 48], [3, 49], [2, 48]]],
    };
    const secondFeature = {
      type: "Feature",
      properties: { commune: "Lyon" },
      geometry: {
        type: "Polygon",
        coordinates: [[[4, 45], [5, 45], [5, 46], [4, 45]]],
      },
    };

    const merged = mergeOutageResponses([
      response(firstPolygon, { total: 1 }),
      response(secondFeature, undefined, [{ id: "crisis-1" }]),
    ]);

    assert.deepEqual(merged.polygon, {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: firstPolygon, properties: {} },
        secondFeature,
      ],
    });
    assert.deepEqual(merged.recap, { total: 1 });
    assert.deepEqual(merged.crises, [{ id: "crisis-1" }]);
  });
});
