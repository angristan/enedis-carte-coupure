import { assert, describe, it } from "@effect/vitest";
import {
  boundsInsideCommuneContours,
  mergeConnectedLines,
} from "./geometry.js";
import { boundsContain, snapBounds, viewportRequest } from "./viewport.js";

describe("viewport utilities", () => {
  it("snaps outward and emits stable request coordinates", () => {
    const bounds = { south: 48.851, west: 2.341, north: 48.859, east: 2.349 };
    assert.deepEqual(snapBounds(bounds, 0.01), {
      south: 48.85,
      west: 2.34,
      north: 48.86,
      east: 2.35,
    });
    assert.strictEqual(
      viewportRequest(bounds).key,
      "south=48.8500&west=2.3400&north=48.8600&east=2.3500",
    );
  });

  it("detects contained and escaping bounds", () => {
    const outer = { south: 48.8, west: 2.2, north: 48.9, east: 2.4 };
    assert.isTrue(
      boundsContain(outer, {
        south: 48.82,
        west: 2.25,
        north: 48.88,
        east: 2.35,
      }),
    );
    assert.isFalse(
      boundsContain(outer, {
        south: 48.82,
        west: 2.19,
        north: 48.88,
        east: 2.35,
      }),
    );
  });
});

describe("map geometry", () => {
  it("joins touching street segments regardless of direction", () => {
    const merged = mergeConnectedLines([
      [[2, 48], [2.1, 48.1]],
      [[2.2, 48.2], [2.1, 48.1]],
      [[3, 49], [3.1, 49.1]],
    ]);
    assert.strictEqual(merged.length, 2);
    assert.deepEqual(merged[0], [[2, 48], [2.1, 48.1], [2.2, 48.2]]);
  });

  it("requires the viewport samples to stay inside commune contours", () => {
    const contour = {
      type: "Polygon",
      coordinates: [[
        [2.3, 48.8],
        [2.4, 48.8],
        [2.4, 48.9],
        [2.3, 48.9],
        [2.3, 48.8],
      ]],
    };
    const communes = [{ contour }];
    assert.isTrue(boundsInsideCommuneContours(
      { south: 48.82, west: 2.32, north: 48.88, east: 2.38 },
      communes,
    ));
    assert.isFalse(boundsInsideCommuneContours(
      { south: 48.82, west: 2.32, north: 48.92, east: 2.38 },
      communes,
    ));
  });
});
