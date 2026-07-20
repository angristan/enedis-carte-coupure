import type { Map as MapLibreMap } from "maplibre-gl";
import type { Bounds, PublicCommune } from "../../../shared/api.js";
import { boundsInsideCommuneContours } from "./spatial.js";

export const MIN_VIEWPORT_ZOOM = 11;
const VIEWPORT_GRID = 0.01;

export interface Viewport {
  readonly zoom: number;
  readonly bounds: Bounds;
}

export interface ViewportRequest {
  readonly bounds: Bounds;
  readonly params: URLSearchParams;
  readonly key: string;
}

export interface ResponseCoverage {
  readonly bounds: Bounds;
  readonly communes: ReadonlyArray<PublicCommune>;
}

export function viewportFromMap(map: MapLibreMap): Viewport {
  const bounds = map.getBounds();
  return {
    zoom: map.getZoom(),
    bounds: {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    },
  };
}

export function viewportRequest(
  bounds: Bounds,
  cursor?: string,
): ViewportRequest {
  const snapped = snapBounds(bounds, VIEWPORT_GRID);
  const params = new URLSearchParams();
  params.set("south", snapped.south.toFixed(4));
  params.set("west", snapped.west.toFixed(4));
  params.set("north", snapped.north.toFixed(4));
  params.set("east", snapped.east.toFixed(4));
  if (cursor !== undefined) params.set("cursor", cursor);
  return { bounds: snapped, params, key: params.toString() };
}

export function coverageContains(
  coverage: ResponseCoverage,
  bounds: Bounds,
): boolean {
  if (coverage.communes.some((commune) => commune.contour != null)) {
    return boundsInsideCommuneContours(bounds, coverage.communes);
  }
  return boundsContain(coverage.bounds, bounds);
}

export function boundsContain(outer: Bounds, inner: Bounds): boolean {
  const epsilon = 1e-9;
  return (
    outer.south <= inner.south + epsilon &&
    outer.west <= inner.west + epsilon &&
    outer.north >= inner.north - epsilon &&
    outer.east >= inner.east - epsilon
  );
}

export function snapBounds(bounds: Bounds, grid: number): Bounds {
  return {
    south: Math.floor(bounds.south / grid) * grid,
    west: Math.floor(bounds.west / grid) * grid,
    north: Math.ceil(bounds.north / grid) * grid,
    east: Math.ceil(bounds.east / grid) * grid,
  };
}
