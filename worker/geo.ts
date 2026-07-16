export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

type BoundsValues = Pick<URLSearchParams, "get" | "has">;

export type ParsedBounds =
  | { hasBounds: false; bounds: null; error?: never }
  | { hasBounds: true; bounds: Bounds; error?: never }
  | { hasBounds: true; error: string; bounds?: never };

export function parseBounds(values: BoundsValues): ParsedBounds {
  try {
    const bbox = trim(values.get("bbox"));
    if (bbox) {
      const parts = bbox.split(",");
      if (parts.length !== 4) {
        return { hasBounds: true, error: "bbox must be west,south,east,north" };
      }
      const west = parseCoordinate(parts[0], "bbox west");
      const south = parseCoordinate(parts[1], "bbox south");
      const east = parseCoordinate(parts[2], "bbox east");
      const north = parseCoordinate(parts[3], "bbox north");
      return normalizeAndValidate({ south, west, north, east });
    }

    const names = ["south", "west", "north", "east"];
    if (!names.some((name) => values.has(name))) {
      return { hasBounds: false, bounds: null };
    }
    for (const name of names) {
      if (!values.has(name)) return { hasBounds: true, error: `missing ${name}` };
    }

    return normalizeAndValidate({
      south: parseCoordinate(values.get("south"), "south"),
      west: parseCoordinate(values.get("west"), "west"),
      north: parseCoordinate(values.get("north"), "north"),
      east: parseCoordinate(values.get("east"), "east"),
    });
  } catch (error) {
    return { hasBounds: true, error: error instanceof Error ? error.message : "invalid bounds" };
  }
}

export function center(bounds: Bounds) {
  return {
    lat: (bounds.south + bounds.north) / 2,
    lng: (bounds.west + bounds.east) / 2,
  };
}

export function height(bounds: Bounds) {
  return bounds.north - bounds.south;
}

export function width(bounds: Bounds) {
  return bounds.east - bounds.west;
}

export function area(bounds: Bounds) {
  return height(bounds) * width(bounds);
}

export function padded(bounds: Bounds, ratio: number): Bounds {
  if (ratio <= 0) return bounds;
  const latPad = height(bounds) * ratio;
  const lngPad = width(bounds) * ratio;
  return {
    south: clampLatitude(bounds.south - latPad),
    west: clampLongitude(bounds.west - lngPad),
    north: clampLatitude(bounds.north + latPad),
    east: clampLongitude(bounds.east + lngPad),
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

export function boundsCacheKey(bounds: Bounds) {
  return [bounds.south, bounds.west, bounds.north, bounds.east].map((value) => value.toFixed(4)).join(",");
}

export function overpassBBox(bounds: Bounds) {
  return [bounds.south, bounds.west, bounds.north, bounds.east].map((value) => value.toFixed(6)).join(",");
}

export function boundsFromGeoJSONGeometry(geometry) {
  const state = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity, found: false };
  visitCoordinates(geometry?.coordinates, state);
  if (!state.found) return null;
  const bounds = {
    south: clampLatitude(state.south),
    west: clampLongitude(state.west),
    north: clampLatitude(state.north),
    east: clampLongitude(state.east),
  };
  const parsed = normalizeAndValidate(bounds);
  return parsed.error ? null : parsed.bounds;
}

function normalizeAndValidate(bounds: Bounds): ParsedBounds {
  if (Object.values(bounds).some((value) => !Number.isFinite(value))) {
    return { hasBounds: true, error: "invalid bounds" };
  }
  if (bounds.south > bounds.north) {
    [bounds.south, bounds.north] = [bounds.north, bounds.south];
  }
  if (bounds.west > bounds.east) {
    return { hasBounds: true, error: "bounds crossing the antimeridian are not supported" };
  }
  for (const name of ["south", "north"]) {
    if (bounds[name] < -90 || bounds[name] > 90) {
      return { hasBounds: true, error: `${name} must be between -90 and 90` };
    }
  }
  for (const name of ["west", "east"]) {
    if (bounds[name] < -180 || bounds[name] > 180) {
      return { hasBounds: true, error: `${name} must be between -180 and 180` };
    }
  }
  if (height(bounds) <= 0 || width(bounds) <= 0) {
    return { hasBounds: true, error: "bounds must have a positive area" };
  }
  return { hasBounds: true, bounds };
}

function parseCoordinate(value, name) {
  const parsed = Number.parseFloat(trim(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function clampLatitude(value) {
  return Math.max(-90, Math.min(90, value));
}

function clampLongitude(value) {
  return Math.max(-180, Math.min(180, value));
}

function visitCoordinates(value, state) {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    const lng = value[0];
    const lat = value[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    state.south = Math.min(state.south, lat);
    state.west = Math.min(state.west, lng);
    state.north = Math.max(state.north, lat);
    state.east = Math.max(state.east, lng);
    state.found = true;
    return;
  }
  for (const item of value) visitCoordinates(item, state);
}

function trim(value) {
  return String(value || "").trim();
}
