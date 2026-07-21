import { assert, describe, it } from "@effect/vitest";
import type { OutageResponse } from "../../shared/api.js";
import { mergeOutageResponses } from "./outage-merging.js";
import { normalizeOutageInputs } from "./outage-response.js";
import {
  normalizeStreet,
  parseLocalisation,
} from "./street-normalization.js";

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

describe("outage normalization", () => {
  it("merges repeated outages and deduplicates their addresses", () => {
    const normalized = normalizeOutageInputs([{
      query: {
        insee: "75056",
        type: "municipality",
        adresse: "Paris",
        CPVille: "Paris 75001",
        name: "Paris",
        district: "",
        city: "Paris",
      },
      raw: {
        resultMegacache: {
          compteurIncidentHTA: "2",
          compteurTravauxHTA: 1,
          compteurBT: "3",
          listeCoupuresInfoReseau: [
            {
              idCoupure: "outage-1",
              dateCoupure: "21/03/2026 10:00",
              dateRealimentation: "21/03/2026 12:00",
              nbFoyersCoupes: "5",
              listeAdresses: [{
                localisation: "12 R. de Longchamp, PARIS 16 (75116)",
                nbFoyersCoupes: "2",
              }],
            },
            {
              idCoupure: "outage-1",
              dateCoupure: "21/03/2026 09:00",
              dateRealimentation: "21/03/2026 13:00",
              nbFoyersCoupes: 3,
              listeAdresses: [{
                localisation: "12 R. de Longchamp, PARIS 16 (75116)",
                nbFoyersCoupes: 2,
              }],
            },
          ],
        },
      },
    }], "2026-03-21T08:00:00.000Z");

    assert.strictEqual(normalized.outages.length, 1);
    assert.strictEqual(normalized.outages[0]?.nbFoyersCoupes, 8);
    assert.strictEqual(normalized.outages[0]?.dateCoupure, "21/03/2026 09:00");
    assert.strictEqual(
      normalized.outages[0]?.dateRealimentation,
      "21/03/2026 13:00",
    );
    assert.deepEqual(normalized.outages[0]?.addresses, [{
      localisation: "12 R. de Longchamp, PARIS 16 (75116)",
      nbFoyersCoupes: 2,
    }]);
    assert.strictEqual(normalized.stats.addressRows, 2);
    assert.strictEqual(normalized.stats.compteurIncidentHTA, 2);
    assert.strictEqual(normalized.stats.compteurTravauxHTA, 1);
    assert.strictEqual(normalized.stats.compteurBT, 3);
  });
});

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
