import { assert, describe, it } from "@effect/vitest";
import { viewportIsWithinLimits } from "../../../shared/viewport.js";

describe("viewport limits", () => {
  it("accepts a viewport within the API limits", () => {
    assert.isTrue(viewportIsWithinLimits({
      south: 48.7,
      west: 2.0,
      north: 49.1,
      east: 2.7,
    }));
  });

  it("rejects a viewport whose area is too large", () => {
    assert.isFalse(viewportIsWithinLimits({
      south: 48.5,
      west: 2.0,
      north: 49.1,
      east: 2.6,
    }));
  });

  it("rejects a viewport whose span is too large", () => {
    assert.isFalse(viewportIsWithinLimits({
      south: 48.7,
      west: 1.5,
      north: 48.9,
      east: 2.6,
    }));
  });
});
