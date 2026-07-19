import { assert, describe, it } from "@effect/vitest";
import { boundsForCommune, enedisQueryForCommune } from "./communes.js";
import type { Commune } from "./models.js";

const commune: Commune = {
  name: "Paris",
  code: "75056",
  postcodes: ["75001"],
  center: { type: "Point", coordinates: [2.35, 48.85] },
  contour: {
    type: "Polygon",
    coordinates: [[[2, 48], [3, 48], [3, 49], [2, 49], [2, 48]]],
  },
};

describe("commune helpers", () => {
  it("builds an Enedis municipality query", () => {
    assert.deepEqual(enedisQueryForCommune(commune), {
      insee: "75056",
      type: "municipality",
      adresse: "Paris",
      CPVille: "Paris 75001",
      name: "Paris",
      district: "",
      city: "Paris",
      department: "75",
      longitude: "2.350000",
      latitude: "48.850000",
    });
  });

  it("derives padded contour bounds", () => {
    assert.deepEqual(boundsForCommune(commune), {
      south: 47.96,
      west: 1.96,
      north: 49.04,
      east: 3.04,
    });
  });
});
