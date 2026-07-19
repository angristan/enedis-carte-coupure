import type {
  Bounds,
  Position,
  Street,
  StreetGeometryOk,
} from "../../../shared/api.js";

export type Coordinate = [number, number];

const mergedLineCache = new WeakMap<
  StreetGeometryOk,
  ReadonlyArray<ReadonlyArray<Coordinate>>
>();

export function streetBounds(street: Street): Bounds | undefined {
  const lines = mergedGeometryLines(street);

  if (lines.length > 0) {
    const bounds = {
      south: Infinity,
      west: Infinity,
      north: -Infinity,
      east: -Infinity,
    };

    for (const line of lines) {
      for (const [lng, lat] of line) {
        bounds.south = Math.min(bounds.south, lat);
        bounds.west = Math.min(bounds.west, lng);
        bounds.north = Math.max(bounds.north, lat);
        bounds.east = Math.max(bounds.east, lng);
      }
    }

    return Number.isFinite(bounds.south) ? bounds : undefined;
  }

  if (street.geocode?.status !== "ok") return undefined;

  return {
    south: street.geocode.lat,
    west: street.geocode.lng,
    north: street.geocode.lat,
    east: street.geocode.lng,
  };
}

export function hasGeometry(
  street: Street,
): street is Street & { readonly geometry: StreetGeometryOk } {
  return street.geometry?.status === "ok" && street.geometry.lines.length > 0;
}

export function mergedGeometryLines(
  street: Street,
): ReadonlyArray<ReadonlyArray<Coordinate>> {
  if (!hasGeometry(street)) return [];

  const cached = mergedLineCache.get(street.geometry);

  if (cached !== undefined) return cached;

  const lines = street.geometry.lines
    .map(lineCoordinates)
    .map(cleanLine)
    .filter((line) => line.length > 1);
  const merged = mergeConnectedLines(lines);

  mergedLineCache.set(street.geometry, merged);

  return merged;
}

export function mergeConnectedLines(
  lines: ReadonlyArray<ReadonlyArray<Coordinate>>,
  tolerance = 0.000035,
): ReadonlyArray<ReadonlyArray<Coordinate>> {
  const pending = lines.map(copyLine);
  const merged: Array<ReadonlyArray<Coordinate>> = [];

  while (pending.length > 0) {
    const first = pending.shift();

    if (first === undefined) break;

    let current = first;
    let changed = true;

    while (changed) {
      changed = false;

      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];

        if (candidate === undefined) continue;

        const joined = joinLines(current, candidate, tolerance);

        if (joined === undefined) continue;

        current = cleanLine(joined);
        pending.splice(index, 1);
        changed = true;
        break;
      }
    }

    merged.push(current);
  }

  return merged.sort((left, right) => right.length - left.length);
}

export function copyLine(
  line: ReadonlyArray<Coordinate>,
): Array<Coordinate> {
  return line.map(([lng, lat]): Coordinate => [lng, lat]);
}

function lineCoordinates(
  line: ReadonlyArray<Position>,
): ReadonlyArray<Coordinate> {
  return line
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point): Coordinate => [point.lng, point.lat]);
}

function joinLines(
  left: ReadonlyArray<Coordinate>,
  right: ReadonlyArray<Coordinate>,
  tolerance: number,
): Array<Coordinate> | undefined {
  const leftFirst = left[0];
  const leftLast = left[left.length - 1];
  const rightFirst = right[0];
  const rightLast = right[right.length - 1];

  if (
    leftFirst === undefined ||
    leftLast === undefined ||
    rightFirst === undefined ||
    rightLast === undefined
  ) {
    return undefined;
  }

  if (pointsClose(leftLast, rightFirst, tolerance)) {
    return [...left, ...right.slice(1)];
  }

  if (pointsClose(leftLast, rightLast, tolerance)) {
    return [...left, ...copyLine(right).reverse().slice(1)];
  }

  if (pointsClose(leftFirst, rightLast, tolerance)) {
    return [...right, ...left.slice(1)];
  }

  if (pointsClose(leftFirst, rightFirst, tolerance)) {
    return [...copyLine(right).reverse(), ...left.slice(1)];
  }

  return undefined;
}

function cleanLine(line: ReadonlyArray<Coordinate>): Array<Coordinate> {
  const cleaned: Array<Coordinate> = [];

  for (const coordinate of line) {
    const previous = cleaned[cleaned.length - 1];

    if (
      previous === undefined ||
      !pointsClose(previous, coordinate, 0.000001)
    ) {
      cleaned.push(coordinate);
    }
  }

  return cleaned;
}

function pointsClose(
  left: Coordinate,
  right: Coordinate,
  tolerance: number,
): boolean {
  return Math.abs(left[0] - right[0]) <= tolerance &&
    Math.abs(left[1] - right[1]) <= tolerance;
}
