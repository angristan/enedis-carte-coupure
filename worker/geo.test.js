import { describe, expect, it } from "vitest";
import { boundsCacheKey, parseBounds, snapped } from "./geo.js";

describe("geo bounds", () => {
  it("parses bbox in west,south,east,north order", () => {
    const result = parseBounds(new URLSearchParams("bbox=2.2,48.8,2.4,48.9"));
    expect(result).toEqual({
      hasBounds: true,
      bounds: { south: 48.8, west: 2.2, north: 48.9, east: 2.4 },
    });
  });

  it("reports partial viewport params as invalid", () => {
    const result = parseBounds(new URLSearchParams("south=48.8&west=2.2"));
    expect(result.hasBounds).toBe(true);
    expect(result.error).toBe("missing north");
  });

  it("snaps cache keys like the Go viewport cache", () => {
    expect(boundsCacheKey(snapped({ south: 48.8151, west: 2.2241, north: 48.901, east: 2.469 }, 0.01))).toBe(
      "48.8100,2.2200,48.9100,2.4700",
    );
  });
});
