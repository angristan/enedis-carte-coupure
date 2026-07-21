import type { Bounds, Position } from "../../shared/api.js";

export type { Bounds, Position } from "../../shared/api.js";

type BoundsValues = Pick<URLSearchParams, "get" | "has">;

export type ParsedBounds = { readonly hasBounds: false } | {
  readonly hasBounds: true;
  readonly bounds: Bounds;
} | { readonly hasBounds: true; readonly error: string };

export function parseBounds(values: BoundsValues): ParsedBounds {
  const names = ["south", "west", "north", "east"];
  if (!names.some((name) => values.has(name))) return { hasBounds: false };
  for (const name of names) {
    if (!values.has(name)) {
      return { hasBounds: true, error: `missing ${name}` };
    }
  }
  const south = parseCoordinate(values.get("south"), "south");
  const west = parseCoordinate(values.get("west"), "west");
  const north = parseCoordinate(values.get("north"), "north");
  const east = parseCoordinate(values.get("east"), "east");
  if (typeof south === "string") return { hasBounds: true, error: south };
  if (typeof west === "string") return { hasBounds: true, error: west };
  if (typeof north === "string") return { hasBounds: true, error: north };
  if (typeof east === "string") return { hasBounds: true, error: east };
  return normalizeAndValidate({ south, west, north, east });
}

export const center = (bounds: Bounds): Position => ({
  lat: (bounds.south + bounds.north) / 2,
  lng: (bounds.west + bounds.east) / 2,
});

export const height = (bounds: Bounds): number => bounds.north - bounds.south;

export const width = (bounds: Bounds): number => bounds.east - bounds.west;

export const area = (bounds: Bounds): number => height(bounds) * width(bounds);

export function padded(bounds: Bounds, ratio: number): Bounds {
  if (ratio <= 0) return bounds;
  return {
    south: clampLatitude(bounds.south - height(bounds) * ratio),
    west: clampLongitude(bounds.west - width(bounds) * ratio),
    north: clampLatitude(bounds.north + height(bounds) * ratio),
    east: clampLongitude(bounds.east + width(bounds) * ratio),
  };
}

export function snapped(bounds: Bounds, grid: number): Bounds {
  if (grid <= 0) return bounds;
  return {
    south: clampLatitude(Math.floor(bounds.south / grid) * grid),
    west: clampLongitude(Math.floor(bounds.west / grid) * grid),
    north: clampLatitude(Math.ceil(bounds.north / grid) * grid),
    east: clampLongitude(Math.ceil(bounds.east / grid) * grid),
  };
}

export const boundsCacheKey = (bounds: Bounds): string =>
  [bounds.south, bounds.west, bounds.north, bounds.east].map((value) =>
    value.toFixed(4)
  ).join(",");

export const overpassBBox = (bounds: Bounds): string =>
  [bounds.south, bounds.west, bounds.north, bounds.east].map((value) =>
    value.toFixed(6)
  ).join(",");

export function boundsFromGeoJSONGeometry(
  geometry: { readonly coordinates: unknown } | null | undefined,
): Bounds | null {
  const state = {
    south: Infinity,
    west: Infinity,
    north: -Infinity,
    east: -Infinity,
    found: false,
  };
  visitCoordinates(geometry?.coordinates, state);
  if (!state.found) return null;
  const parsed = normalizeAndValidate({
    south: clampLatitude(state.south),
    west: clampLongitude(state.west),
    north: clampLatitude(state.north),
    east: clampLongitude(state.east),
  });
  return "bounds" in parsed ? parsed.bounds : null;
}

function normalizeAndValidate(input: Bounds): ParsedBounds {
  let south = input.south;
  let north = input.north;
  if (
    [south, input.west, north, input.east].some((value) =>
      !Number.isFinite(value)
    )
  ) return { hasBounds: true, error: "invalid bounds" };
  if (south > north) [south, north] = [north, south];
  const bounds = { south, west: input.west, north, east: input.east };
  if (bounds.west > bounds.east) {
    return {
      hasBounds: true,
      error: "bounds crossing the antimeridian are not supported",
    };
  }
  if (bounds.south < -90 || bounds.south > 90) {
    return { hasBounds: true, error: "south must be between -90 and 90" };
  }
  if (bounds.north < -90 || bounds.north > 90) {
    return { hasBounds: true, error: "north must be between -90 and 90" };
  }
  if (bounds.west < -180 || bounds.west > 180) {
    return { hasBounds: true, error: "west must be between -180 and 180" };
  }
  if (bounds.east < -180 || bounds.east > 180) {
    return { hasBounds: true, error: "east must be between -180 and 180" };
  }
  if (height(bounds) <= 0 || width(bounds) <= 0) {
    return { hasBounds: true, error: "bounds must have a positive area" };
  }
  return { hasBounds: true, bounds };
}

function parseCoordinate(value: string | null, name: string): number | string {
  const normalized = trim(value);
  if (normalized.length === 0) return `invalid ${name}`;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : `invalid ${name}`;
}

const clampLatitude = (value: number): number =>
  Math.max(-90, Math.min(90, value));

const clampLongitude = (value: number): number =>
  Math.max(-180, Math.min(180, value));

function visitCoordinates(
  value: unknown,
  state: {
    south: number;
    west: number;
    north: number;
    east: number;
    found: boolean;
  },
): void {
  if (!Array.isArray(value)) return;
  const first: unknown = value[0];
  const second: unknown = value[1];
  if (typeof first === "number" && typeof second === "number") {
    if (!Number.isFinite(first) || !Number.isFinite(second)) return;
    state.south = Math.min(state.south, second);
    state.west = Math.min(state.west, first);
    state.north = Math.max(state.north, second);
    state.east = Math.max(state.east, first);
    state.found = true;
    return;
  }

  for (const item of value) visitCoordinates(item, state);
}

const trim = (value: string | null): string => value?.trim() ?? "";
