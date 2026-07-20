import { assert, describe, it } from "@effect/vitest";
import { viewportIsWithinLimits } from "../../../shared/viewport.js";
import { viewportRequest } from "./viewport.js";

describe("viewport limits", () => {
  it("adds a commune limit to progressive requests", () => {
    const request = viewportRequest({
      south: 48.801,
      west: 2.201,
      north: 48.899,
      east: 2.399,
    }, 12);

    assert.strictEqual(request.params.get("communeLimit"), "12");
    assert.strictEqual(request.params.get("south"), "48.8000");
    assert.strictEqual(request.params.get("west"), "2.2000");
    assert.strictEqual(request.params.get("north"), "48.9000");
    assert.strictEqual(request.params.get("east"), "2.4000");
  });

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
