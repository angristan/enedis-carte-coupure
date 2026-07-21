import { assert, describe, it } from "@effect/vitest";
import { boundsCacheKey, parseBounds, snapped } from "./geo.js";

describe("geo bounds", () => {
  it("parses explicit viewport coordinates", () => {
    assert.deepEqual(
      parseBounds(
        new URLSearchParams("south=48.8&west=2.2&north=48.9&east=2.4"),
      ),
      {
        hasBounds: true,
        bounds: { south: 48.8, west: 2.2, north: 48.9, east: 2.4 },
      },
    );
  });
  it("rejects coordinates with trailing garbage", () => {
    const result = parseBounds(
      new URLSearchParams("south=48oops&west=2.2&north=48.9&east=2.4"),
    );
    assert.deepEqual(result, {
      hasBounds: true,
      error: "invalid south",
    });
  });
  it("reports partial viewport params as invalid", () => {
    const result = parseBounds(new URLSearchParams("south=48.8&west=2.2"));
    assert.isTrue(result.hasBounds && "error" in result);
    if (result.hasBounds && "error" in result) {
      assert.strictEqual(result.error, "missing north");
    }
  });
  it("snaps viewport cache keys", () => {
    assert.strictEqual(
      boundsCacheKey(
        snapped(
          { south: 48.8151, west: 2.2241, north: 48.901, east: 2.469 },
          0.01,
        ),
      ),
      "48.8100,2.2200,48.9100,2.4700",
    );
  });
});
