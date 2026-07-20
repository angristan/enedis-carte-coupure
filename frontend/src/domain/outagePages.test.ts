import { assert, describe, it } from "@effect/vitest";
import type { OutageResponse } from "../../../shared/api.js";
import { mergeOutagePages } from "./outagePages.js";

const source = {
  enedisEndpoint: "enedis",
  geocoderEndpoint: "geocoder",
  geocoderFallbackEndpoint: "fallback",
  streetGeometryEndpoint: "geometry",
};

function page(code: string, nextCursor?: string): OutageResponse {
  return {
    updatedAt: `2026-01-01T00:00:0${code.at(-1)}.000Z`,
    source,
    query: {
      insee: code,
      type: "municipality",
      adresse: `City ${code}`,
      CPVille: `City ${code}`,
      name: `City ${code}`,
      district: "",
      city: `City ${code}`,
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
      id: `outage-${code}`,
      status: "active",
      type: "Incident HTA",
      etatElectrique: 1,
      codeInsee: code,
      dateCoupure: "01/01/2026 10:00",
      dateRealimentation: "01/01/2026 11:00",
      nbFoyersCoupes: 1,
      addresses: [{ localisation: `Street ${code}`, nbFoyersCoupes: 1 }],
    }],
    streets: [{
      key: `STREET|${code}`,
      label: `Street ${code}`,
      normalizedName: "STREET",
      city: `City ${code}`,
      postcode: "",
      localisations: [`Street ${code}`],
      outageIds: [`outage-${code}`],
      outageTypes: ["Incident HTA"],
      firstSeenAt: "01/01/2026 10:00",
      estimatedRestoreAt: "01/01/2026 11:00",
      nbFoyersCoupes: 1,
      geocode: {
        status: "ok",
        query: `Street ${code}`,
        lng: 2.3,
        lat: 48.8,
        label: `Street ${code}`,
        type: "street",
        postcode: "",
        citycode: code,
      },
    }],
    viewport: { south: 48.8, west: 2.2, north: 48.9, east: 2.4 },
    communes: [{ code, name: `City ${code}`, postcodes: [] }],
    communeTotal: 2,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

describe("outage page merging", () => {
  it("combines disjoint pages and keeps the latest cursor", () => {
    const merged = mergeOutagePages([page("78001", "next"), page("78002")]);
    assert.isNotNull(merged);
    if (merged === null) return;
    assert.deepEqual(merged.communes?.map((item) => item.code), [
      "78001",
      "78002",
    ]);
    assert.strictEqual(merged.stats.outages, 2);
    assert.strictEqual(merged.stats.streets, 2);
    assert.strictEqual(merged.stats.addressRows, 2);
    assert.strictEqual(merged.nextCursor, undefined);
  });

  it("returns null before the first page", () => {
    assert.strictEqual(mergeOutagePages([]), null);
  });
});
