import { assert, describe, it } from "@effect/vitest";
import { decodeAreaFeatureCollection } from "./areaFeatures.js";

describe("area feature decoding", () => {
  it("accepts polygon and multipolygon feature collections", () => {
    const polygonCoordinates = [[
      [2.3, 48.8],
      [2.4, 48.8],
      [2.4, 48.9],
      [2.3, 48.8],
    ]];
    const multiPolygonCoordinates = [polygonCoordinates];

    assert.deepEqual(
      decodeAreaFeatureCollection({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { code: "75056" },
            geometry: {
              type: "Polygon",
              coordinates: polygonCoordinates,
            },
          },
          {
            type: "Feature",
            geometry: {
              type: "MultiPolygon",
              coordinates: multiPolygonCoordinates,
            },
          },
        ],
      }),
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { code: "75056" },
            geometry: {
              type: "Polygon",
              coordinates: polygonCoordinates,
            },
          },
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "MultiPolygon",
              coordinates: multiPolygonCoordinates,
            },
          },
        ],
      },
    );
  });

  it("rejects malformed area feature collections", () => {
    assert.isUndefined(decodeAreaFeatureCollection({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Polygon", coordinates: "invalid" },
      }],
    }));
  });
});
