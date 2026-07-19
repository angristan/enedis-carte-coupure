import { Option, Schema } from "effect";
import type { Bounds, Position } from "../../../shared/api.js";

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
