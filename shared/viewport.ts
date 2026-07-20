import type { Bounds } from "./api.js";

export const MAX_VIEWPORT_AREA = 0.35;
export const MAX_VIEWPORT_SPAN = 1;

export function viewportIsWithinLimits(bounds: Bounds): boolean {
  const height = bounds.north - bounds.south;
  const width = bounds.east - bounds.west;

  return height > 0 &&
    width > 0 &&
    height <= MAX_VIEWPORT_SPAN &&
    width <= MAX_VIEWPORT_SPAN &&
    height * width <= MAX_VIEWPORT_AREA;
}
