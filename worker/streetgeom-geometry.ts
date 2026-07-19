import type { Position } from "./geo.js";
import type { StreetGeometry } from "./models.js";

const MAX_POINT_MATCH_METERS = 1800;
const POINT_MATCH_SLACK_METERS = 350;
const COMPONENT_JOIN_METERS = 35;
const EARTH_RADIUS_METERS = 6_371_000;

export function filterStreetGeometryNearPoint(
  result: StreetGeometry,
  point: Position,
): StreetGeometry {
  if (result.status !== "ok" || result.lines.length === 0) return result;

  const components = connectedComponents(result.lines);
  const distances = components.map((component) =>
    componentDistanceMeters(result.lines, component, point)
  );
  const closest = Math.min(...distances);

  if (!Number.isFinite(closest) || closest > MAX_POINT_MATCH_METERS) {
    return {
      status: "miss",
      query: result.query ?? "",
      updatedAt: result.updatedAt ?? "",
      message: `no OSM geometry within ${MAX_POINT_MATCH_METERS}m`,
    };
  }

  const distanceLimit = Math.min(
    MAX_POINT_MATCH_METERS,
    closest + POINT_MATCH_SLACK_METERS,
  );
  const lines: Array<ReadonlyArray<Position>> = [];

  components.forEach((component, index) => {
    if (distances[index] > distanceLimit) return;

    for (const lineIndex of component) {
      lines.push(result.lines[lineIndex]);
    }
  });

  return { ...result, lines };
}

function connectedComponents(
  lines: ReadonlyArray<ReadonlyArray<Position>>,
): Array<Array<number>> {
  const visited = new Array<boolean>(lines.length).fill(false);
  const components: Array<Array<number>> = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (visited[index]) continue;

    visited[index] = true;
    const component = [index];
    const queue = [index];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;

      for (let candidate = 0; candidate < lines.length; candidate += 1) {
        if (
          !visited[candidate] &&
          linesTouch(lines[current], lines[candidate])
        ) {
          visited[candidate] = true;
          component.push(candidate);
          queue.push(candidate);
        }
      }
    }

    components.push(component);
  }

  return components;
}

function linesTouch(
  left: ReadonlyArray<Position>,
  right: ReadonlyArray<Position>,
): boolean {
  const leftEndpoints = endpoints(left);
  const rightEndpoints = endpoints(right);

  return leftEndpoints !== undefined &&
    rightEndpoints !== undefined &&
    leftEndpoints.some((leftPoint) =>
      rightEndpoints.some((rightPoint) =>
        pointDistanceMeters(leftPoint, rightPoint) <= COMPONENT_JOIN_METERS
      )
    );
}

function endpoints(
  line: ReadonlyArray<Position>,
): ReadonlyArray<Position> | undefined {
  return line.length === 0 ? undefined : [line[0], line[line.length - 1]];
}

function componentDistanceMeters(
  lines: ReadonlyArray<ReadonlyArray<Position>>,
  component: ReadonlyArray<number>,
  point: Position,
): number {
  return Math.min(
    ...component.map((index) => lineDistanceMeters(lines[index], point)),
  );
}

function lineDistanceMeters(
  line: ReadonlyArray<Position>,
  point: Position,
): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return pointDistanceMeters(line[0], point);

  let closest = Infinity;

  for (let index = 1; index < line.length; index += 1) {
    closest = Math.min(
      closest,
      segmentDistanceMeters(point, line[index - 1], line[index]),
    );
  }

  return closest;
}

function segmentDistanceMeters(
  point: Position,
  start: Position,
  end: Position,
): number {
  const pointX = longitudeToMeters(point.lng, point.lat);
  const pointY = latitudeToMeters(point.lat);
  const startX = longitudeToMeters(start.lng, point.lat);
  const startY = latitudeToMeters(start.lat);
  const endX = longitudeToMeters(end.lng, point.lat);
  const endY = latitudeToMeters(end.lat);
  const deltaX = endX - startX;
  const deltaY = endY - startY;

  if (deltaX === 0 && deltaY === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((pointX - startX) * deltaX + (pointY - startY) * deltaY) /
        (deltaX * deltaX + deltaY * deltaY),
    ),
  );
  const projectedX = startX + projection * deltaX;
  const projectedY = startY + projection * deltaY;

  return Math.hypot(pointX - projectedX, pointY - projectedY);
}

function pointDistanceMeters(left: Position, right: Position): number {
  const averageLatitude = (left.lat + right.lat) / 2;

  return Math.hypot(
    longitudeToMeters(left.lng - right.lng, averageLatitude),
    latitudeToMeters(left.lat - right.lat),
  );
}

function longitudeToMeters(delta: number, latitude: number): number {
  return (
    delta *
    Math.PI *
    EARTH_RADIUS_METERS *
    Math.cos((latitude * Math.PI) / 180)
  ) / 180;
}

function latitudeToMeters(delta: number): number {
  return (delta * Math.PI * EARTH_RADIUS_METERS) / 180;
}
