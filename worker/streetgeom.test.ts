import { assert, describe, it } from "@effect/vitest";
import type { Bounds, Position } from "./geo.js";
import type { StreetGeometry } from "./models.js";
import { filterStreetGeometryNearPoint } from "./streetgeom-geometry.js";
import {
  buildStreetLookupQuery,
  streetGeometriesFromPayload,
  streetKey,
} from "./streetgeom-overpass.js";

const bounds: Bounds = {
  south: 48.8,
  west: 2.2,
  north: 48.9,
  east: 2.4,
};

describe("street geometry Overpass helpers", () => {
  it("normalizes accented street names", () => {
    assert.strictEqual(streetKey("  Rue de l'Église "), "RUE DE L'EGLISE");
  });

  it("builds an unrestricted lookup for an empty name list", () => {
    assert.strictEqual(
      buildStreetLookupQuery(bounds, []),
      '[out:json][timeout:45];way["highway"]["name"](48.800000,2.200000,48.900000,2.400000);out tags geom;',
    );
  });

  it("batches name filters and expands accented characters", () => {
    const names = Array.from(
      { length: 37 },
      (_, index) => `RUE EXEMPLE ${index}`,
    );
    const query = buildStreetLookupQuery(bounds, names);

    assert.strictEqual(query.match(/way\[/g)?.length, 2);
    assert.include(query, "[EÈÉÊËèéêë]");
    assert.include(query, `[ ./'’-]+`);
  });

  it("groups valid Overpass ways by normalized name", () => {
    const geometries = streetGeometriesFromPayload({
      elements: [
        {
          type: "way",
          tags: { name: " Rue de l'Église " },
          geometry: [
            { lat: 48.85, lon: 2.35 },
            { lat: 48.851, lon: 2.351 },
          ],
        },
        {
          type: "node",
          tags: { name: "Rue ignorée" },
          geometry: [
            { lat: 48.85, lon: 2.35 },
            { lat: 48.851, lon: 2.351 },
          ],
        },
      ],
    }, "overpass");

    assert.deepEqual(geometries["RUE DE L'EGLISE"], {
      status: "ok",
      source: "overpass",
      osmNames: ["Rue de l'Église"],
      lines: [[
        { lat: 48.85, lng: 2.35 },
        { lat: 48.851, lng: 2.351 },
      ]],
    });
    assert.strictEqual(Object.keys(geometries).length, 1);
  });
});

describe("street geometry proximity", () => {
  const nearbyPoint: Position = { lat: 48.85, lng: 2.35 };
  const connectedLine = [
    { lat: 48.85, lng: 2.3512 },
    { lat: 48.85, lng: 2.352 },
  ];
  const disconnectedLine = [
    { lat: 48.85, lng: 2.36 },
    { lat: 48.85, lng: 2.361 },
  ];
  const geometry: StreetGeometry = {
    status: "ok",
    source: "overpass",
    osmNames: ["Rue Exemple"],
    lines: [
      [
        { lat: 48.85, lng: 2.35 },
        { lat: 48.85, lng: 2.351 },
      ],
      connectedLine,
      disconnectedLine,
    ],
  };

  it("keeps the connected component nearest the requested point", () => {
    const filtered = filterStreetGeometryNearPoint(geometry, nearbyPoint);

    assert.strictEqual(filtered.status, "ok");
    if (filtered.status === "ok") {
      assert.deepEqual(filtered.lines, geometry.lines.slice(0, 2));
    }
  });

  it("returns a miss when every component is too far away", () => {
    assert.deepEqual(
      filterStreetGeometryNearPoint(geometry, { lat: 49, lng: 3 }),
      {
        status: "miss",
        query: "",
        updatedAt: "",
        message: "no OSM geometry within 1800m",
      },
    );
  });
});
