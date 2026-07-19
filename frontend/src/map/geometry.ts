import type { FeatureCollection, MultiLineString, Point } from "geojson";
import { Option, Schema } from "effect";
import type {
  Bounds,
  Position,
  Street,
  StreetGeometryOk,
} from "../../../shared/api.js";

export type Coordinate = [number, number];

interface StreetFeatureProperties {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly lineWidth: number;
  readonly radius: number;
  readonly selected: boolean;
}

export type StreetFeatureCollection = FeatureCollection<
  MultiLineString | Point,
  StreetFeatureProperties
>;

interface PolygonGeometry {
  readonly type: "Polygon";
  readonly coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
}

interface MultiPolygonGeometry {
  readonly type: "MultiPolygon";
  readonly coordinates: ReadonlyArray<
    ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>
  >;
}

type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

const RingSchema = Schema.Array(Schema.Array(Schema.Number));
const PolygonGeometrySchema = Schema.Struct({
  type: Schema.Literal("Polygon"),
  coordinates: Schema.Array(RingSchema),
});
const MultiPolygonGeometrySchema = Schema.Struct({
  type: Schema.Literal("MultiPolygon"),
  coordinates: Schema.Array(Schema.Array(RingSchema)),
});
const AreaGeometrySchema = Schema.Union([
  PolygonGeometrySchema,
  MultiPolygonGeometrySchema,
]);
const decodeAreaGeometry = Schema.decodeUnknownOption(AreaGeometrySchema);

const mergedLineCache = new WeakMap<
  StreetGeometryOk,
  ReadonlyArray<ReadonlyArray<Coordinate>>
>();

export function streetFeatureCollection(
  streets: ReadonlyArray<Street>,
  activeKey: string,
): StreetFeatureCollection {
  const features: StreetFeatureCollection["features"] = [];
  for (const street of streets) {
    const properties: StreetFeatureProperties = {
      key: street.key,
      label: street.label,
      color: markerColor(street),
      lineWidth: lineWeight(street),
      radius: markerRadius(street),
      selected: street.key === activeKey,
    };
    const lines = mergedGeometryLines(street);
    if (lines.length > 0) {
      features.push({
        type: "Feature",
        id: street.key,
        properties,
        geometry: { type: "MultiLineString", coordinates: lines.map(copyLine) },
      });
    } else if (street.geocode?.status === "ok") {
      features.push({
        type: "Feature",
        id: street.key,
        properties,
        geometry: {
          type: "Point",
          coordinates: [street.geocode.lng, street.geocode.lat],
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

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

export function hasMapLayer(street: Street): boolean {
  return hasGeometry(street) || street.geocode?.status === "ok";
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
    .map(lineCoords)
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

export function boundsInsideCommuneContours(
  bounds: Bounds,
  communes: ReadonlyArray<{ readonly contour?: unknown }>,
): boolean {
  const contours = communes.flatMap((commune): ReadonlyArray<AreaGeometry> => {
    const decoded = decodeAreaGeometry(commune.contour);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  if (contours.length === 0) return false;
  return boundsSamplePoints(bounds).every((point) =>
    contours.some((contour) => pointInGeometry(point, contour))
  );
}

export function pointInGeometry(
  point: Position,
  geometry: AreaGeometry,
): boolean {
  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates);
  }
  return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
}

function boundsSamplePoints(bounds: Bounds): ReadonlyArray<Position> {
  const midLat = (bounds.south + bounds.north) / 2;
  const midLng = (bounds.west + bounds.east) / 2;
  return [
    { lat: bounds.south, lng: bounds.west },
    { lat: bounds.south, lng: midLng },
    { lat: bounds.south, lng: bounds.east },
    { lat: midLat, lng: bounds.west },
    { lat: midLat, lng: midLng },
    { lat: midLat, lng: bounds.east },
    { lat: bounds.north, lng: bounds.west },
    { lat: bounds.north, lng: midLng },
    { lat: bounds.north, lng: bounds.east },
  ];
}

function pointInPolygon(
  point: Position,
  rings: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>,
): boolean {
  const outer = rings[0];
  if (outer === undefined || !pointInRing(point, outer)) return false;
  return !rings.slice(1).some((ring) => pointInRing(point, ring));
}

function pointInRing(
  point: Position,
  ring: ReadonlyArray<ReadonlyArray<number>>,
): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    const currentLng = currentPoint?.[0];
    const currentLat = currentPoint?.[1];
    const previousLng = previousPoint?.[0];
    const previousLat = previousPoint?.[1];
    if (
      currentLat === undefined ||
      currentLng === undefined ||
      previousLat === undefined ||
      previousLng === undefined ||
      !Number.isFinite(currentLat) ||
      !Number.isFinite(currentLng) ||
      !Number.isFinite(previousLat) ||
      !Number.isFinite(previousLng)
    ) {
      continue;
    }
    const intersects = (currentLat > point.lat) !== (previousLat > point.lat) &&
      point.lng <
        ((previousLng - currentLng) * (point.lat - currentLat)) /
              (previousLat - currentLat) + currentLng;
    if (intersects) inside = !inside;
  }
  return inside;
}

function lineCoords(line: ReadonlyArray<Position>): ReadonlyArray<Coordinate> {
  return line
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point): Coordinate => [point.lng, point.lat]);
}

function copyLine(line: ReadonlyArray<Coordinate>): Array<Coordinate> {
  return line.map(([lng, lat]): Coordinate => [lng, lat]);
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
    leftFirst === undefined || leftLast === undefined ||
    rightFirst === undefined || rightLast === undefined
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
      previous === undefined || !pointsClose(previous, coordinate, 0.000001)
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

function markerColor(street: Street): string {
  if (street.outageTypes.includes("Incident HTA")) return "#d84a3a";
  if (street.outageTypes.includes("Incident BT")) return "#db7100";
  return "#087b72";
}

function markerRadius(street: Street): number {
  const count = street.outageIds.length || 1;
  return Math.min(13, 7 + count * 1.5);
}

function lineWeight(street: Street): number {
  const count = street.outageIds.length || 1;
  return Math.min(6.6, 4.2 + Math.min(1.2, (count - 1) * 0.35));
}
