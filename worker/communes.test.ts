import { describe, expect, it } from "vitest";
import { KVJSONStore, MemoryKVNamespace } from "./cache.js";
import { cachedCommunesForBounds } from "./communes.js";

const FAKE_CONTOUR = {
  type: "Polygon",
  coordinates: [
    [
      [2.0, 48.0],
      [3.0, 48.0],
      [3.0, 49.0],
      [2.0, 49.0],
      [2.0, 48.0],
    ],
  ],
};

describe("commune viewport cache", () => {
  it("reuses cached commune contours for shifted bbox sample points", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(
        JSON.stringify([
          {
            nom: "Paris",
            code: "75056",
            codesPostaux: ["75001"],
            centre: { type: "Point", coordinates: [2.35, 48.85] },
            contour: FAKE_CONTOUR,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const store = new KVJSONStore(new MemoryKVNamespace(), "commune-test");
      const first = await cachedCommunesForBounds(
        { south: 48.1, west: 2.1, north: 48.3, east: 2.3 },
        30,
        store,
        {},
        604800,
      );
      const firstFetches = fetches;
      const second = await cachedCommunesForBounds(
        { south: 48.12, west: 2.12, north: 48.32, east: 2.32 },
        30,
        store,
        {},
        604800,
      );

      expect(first.map((commune) => commune.code)).toEqual(["75056"]);
      expect(second.map((commune) => commune.code)).toEqual(["75056"]);
      expect(firstFetches).toBeGreaterThan(0);
      expect(fetches).toBe(firstFetches);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
