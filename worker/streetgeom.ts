import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { UpstreamError } from "./errors.js";
import {
  type Bounds,
  boundsCacheKey,
  overpassBBox,
  padded,
  type Position,
  snapped,
} from "./geo.js";
import {
  OverpassPayloadSchema,
  type StreetGeometry,
  type StreetGeometryResults,
  StreetGeometrySchema,
  type StreetRequest,
} from "./models.js";
import { KVStore, RawHttp } from "./platform.js";
import { stripAccents, uniqueSorted } from "./util.js";

export const STREET_GEOMETRY_PRIMARY_ENDPOINT =
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
export const STREET_GEOMETRY_FALLBACK_ENDPOINT =
  "https://lz4.overpass-api.de/api/interpreter";
const VIEWPORT_PADDING_RATIO = 0.08;
const VIEWPORT_SNAP_GRID = 0.005;
const INDEX_TTL = 24 * 60 * 60;
const MAX_BATCH_SIZE = 36;
const MAX_POINT_MATCH_METERS = 1800;
const POINT_MATCH_SLACK_METERS = 350;
const COMPONENT_JOIN_METERS = 35;
const BoundsSchema = Schema.Struct({
  south: Schema.Number,
  west: Schema.Number,
  north: Schema.Number,
  east: Schema.Number,
});
const IndexSchema = Schema.Struct({
  version: Schema.Literal(4),
  updatedAt: Schema.String,
  source: Schema.String,
  bounds: BoundsSchema,
  streets: Schema.Record(Schema.String, StreetGeometrySchema),
});
type Index = Schema.Schema.Type<typeof IndexSchema>;

export class StreetGeometryProvider
  extends Context.Service<StreetGeometryProvider, {
    readonly streetRequests: (
      requests: ReadonlyArray<StreetRequest>,
    ) => Effect.Effect<StreetGeometryResults, UpstreamError>;
    readonly streetRequestsInBounds: (
      requests: ReadonlyArray<StreetRequest>,
      bounds: Bounds,
    ) => Effect.Effect<StreetGeometryResults, UpstreamError>;
  }>()("StreetGeometryProvider") {}

export const StreetGeometryProviderLive = Layer.effect(StreetGeometryProvider)(
  Effect.gen(function* () {
    const http = yield* RawHttp;
    const cache = yield* KVStore;
    const lookup = Effect.fn("StreetGeometry.lookup")(
      function* (
        endpoint: string,
        bounds: Bounds,
        nameKeys: ReadonlyArray<string>,
      ) {
        const form = new URLSearchParams();
        form.set("data", buildLookupQuery(bounds, nameKeys));
        const decoded = yield* http.json({
          provider: "Overpass",
          operation: "streetgeom.lookup",
          url: endpoint,
          attributes: {
            "streetgeom.endpoint": endpoint,
            "streetgeom.names": nameKeys.length,
          },
          init: {
            method: "POST",
            body: form,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "enedis-carte-coupure/1.0",
            },
          },
        }, OverpassPayloadSchema);
        const grouped = new Map<
          string,
          {
            source: string;
            osmNames: Array<string>;
            lines: Array<Array<Position>>;
          }
        >();
        for (const element of decoded.elements ?? []) {
          if (
            element.type !== "way" || element.geometry === undefined ||
            element.geometry.length < 2
          ) continue;
          const name = element.tags?.name?.trim() ?? "";
          const key = streetKey(name);
          if (key.length === 0) continue;
          const current = grouped.get(key) ??
            { source: endpoint, osmNames: [], lines: [] };
          if (!current.osmNames.includes(name)) current.osmNames.push(name);
          current.lines.push(
            element.geometry.map((point) => ({
              lat: point.lat,
              lng: point.lon,
            })),
          );
          grouped.set(key, current);
        }
        const output: Record<string, StreetGeometry> = {};
        for (const [key, result] of grouped) {
          output[key] = {
            status: "ok",
            source: result.source,
            osmNames: result.osmNames.sort((a, b) => a.localeCompare(b)),
            lines: result.lines,
          };
        }
        return output;
      },
    );
    const fetchGeometry = (
      bounds: Bounds,
      keys: ReadonlyArray<string>,
    ): Effect.Effect<Readonly<Record<string, StreetGeometry>>, UpstreamError> =>
      lookup(STREET_GEOMETRY_PRIMARY_ENDPOINT, bounds, keys).pipe(
        Effect.catch(() =>
          lookup(STREET_GEOMETRY_FALLBACK_ENDPOINT, bounds, keys)
        ),
      );

    const forIndex = Effect.fn("StreetGeometry.forIndex")(
      function* (
        requests: ReadonlyArray<StreetRequest>,
        bounds: Bounds,
        indexKey: string,
      ) {
        const requested = requestedRequests(requests);
        if (requested.size === 0) return {};
        const cacheKey = `streetgeom:${indexKey}`;
        const cached = yield* cache.get(cacheKey, IndexSchema, 3600).pipe(
          Effect.catchTag("CacheError", () => Effect.succeed(null)),
        );
        const missing = uniqueSorted(
          Array.from(requested.values(), (request) => streetKey(request.name))
            .filter((key) => cached?.streets[key] === undefined),
        );
        let index: Index;
        if (missing.length > 0) {
          const grouped = yield* fetchGeometry(bounds, missing);
          const now = yield* Clock.currentTimeMillis;
          const updatedAt = new Date(now).toISOString();
          const streets: Record<string, StreetGeometry> = {
            ...(cached?.streets ?? {}),
          };
          for (const key of missing) {
            streets[key] = grouped[key] ??
              { status: "miss", query: key, updatedAt };
          }
          index = {
            version: 4,
            updatedAt,
            source: STREET_GEOMETRY_PRIMARY_ENDPOINT,
            bounds,
            streets,
          };
          yield* cache.set(cacheKey, index, INDEX_TTL).pipe(
            Effect.catchTag("CacheError", () => Effect.void),
          );
        } else {index = cached ??
            { version: 4, updatedAt: "", source: "", bounds, streets: {} };}
        const output: Record<string, StreetGeometry> = {};
        for (const [resultKey, request] of requested) {
          const found = index.streets[streetKey(request.name)] ??
            { status: "miss", query: request.name, updatedAt: index.updatedAt };
          const named: StreetGeometry = found.status === "ok"
            ? { ...found, query: request.name }
            : { ...found, query: request.name };
          output[resultKey] = request.point === undefined
            ? named
            : filterResultNearPoint(named, request.point);
        }
        return output;
      },
    );
    return {
      streetRequests: (requests) =>
        forIndex(requests, defaultBounds(), "paris"),
      streetRequestsInBounds: (requests, bounds) => {
        const indexBounds = snapped(
          padded(bounds, VIEWPORT_PADDING_RATIO),
          VIEWPORT_SNAP_GRID,
        );
        return forIndex(
          requests,
          indexBounds,
          `streets:${boundsCacheKey(indexBounds)}`,
        );
      },
    };
  }),
);

export const streetKey = (value: string): string =>
  stripAccents(value.trim()).toUpperCase();
function defaultBounds(): Bounds {
  return { south: 48.815, west: 2.224, north: 48.902, east: 2.47 };
}
function requestedRequests(
  requests: ReadonlyArray<StreetRequest>,
): Map<string, StreetRequest> {
  const output = new Map<string, StreetRequest>();
  for (const request of requests) {
    const name = request.name.trim();
    const key = streetKey(name);
    if (key.length > 0) {
      output.set(request.id.trim() || key, { ...request, name });
    }
  }
  return output;
}
function buildLookupQuery(
  bounds: Bounds,
  rawNameKeys: ReadonlyArray<string>,
): string {
  const nameKeys = uniqueSorted(rawNameKeys);
  if (nameKeys.length === 0) {
    return `[out:json][timeout:45];way["highway"]["name"](${
      overpassBBox(bounds)
    });out tags geom;`;
  }
  const parts: Array<string> = [];
  for (let start = 0; start < nameKeys.length; start += MAX_BATCH_SIZE) {
    const regexes = nameKeys.slice(start, start + MAX_BATCH_SIZE).map(
      nameRegexFromKey,
    ).filter((value) => value.length > 0);
    if (regexes.length > 0) {
      parts.push(
        `way["highway"]["name"~"^ *(${
          escapeOverpassRegex(regexes.join("|"))
        }) *$",i](${overpassBBox(bounds)});`,
      );
    }
  }
  return `[out:json][timeout:45];(${parts.join("")});out tags geom;`;
}
const nameRegexFromKey = (key: string): string =>
  key.trim().split(/\s+/).map(tokenRegex).filter((value) => value.length > 0)
    .join(`[ ./'’-]+`);
function tokenRegex(token: string): string {
  const variants: Readonly<Record<string, string>> = {
    A: "[AÀÁÂÃÄÅàáâãäå]",
    C: "[CÇç]",
    E: "[EÈÉÊËèéêë]",
    I: "[IÌÍÎÏìíîï]",
    N: "[NÑñ]",
    O: "[OÒÓÔÕÖòóôõö]",
    U: "[UÙÚÛÜùúûü]",
    Y: "[YÝŸýÿ]",
  };
  return Array.from(
    token,
    (char) =>
      variants[char] ??
        (/[A-Z0-9]/.test(char)
          ? char
          : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
  ).join("");
}
const escapeOverpassRegex = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
function filterResultNearPoint(
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
  const limit = Math.min(
    MAX_POINT_MATCH_METERS,
    closest + POINT_MATCH_SLACK_METERS,
  );
  const lines: Array<ReadonlyArray<Position>> = [];
  components.forEach((component, index) => {
    if (distances[index] <= limit) {
      for (const lineIndex of component) lines.push(result.lines[lineIndex]);
    }
  });
  return { ...result, lines };
}
function connectedComponents(
  lines: ReadonlyArray<ReadonlyArray<Position>>,
): Array<Array<number>> {
  const visited = new Array<boolean>(lines.length).fill(false);
  const output: Array<Array<number>> = [];
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
          !visited[candidate] && linesTouch(lines[current], lines[candidate])
        ) {
          visited[candidate] = true;
          component.push(candidate);
          queue.push(candidate);
        }
      }
    }
    output.push(component);
  }
  return output;
}
function linesTouch(
  left: ReadonlyArray<Position>,
  right: ReadonlyArray<Position>,
): boolean {
  const a = endpoints(left);
  const b = endpoints(right);
  return a !== undefined && b !== undefined &&
    a.some((p) =>
      b.some((q) => pointDistanceMeters(p, q) <= COMPONENT_JOIN_METERS)
    );
}
const endpoints = (
  line: ReadonlyArray<Position>,
): ReadonlyArray<Position> | undefined =>
  line.length === 0 ? undefined : [line[0], line[line.length - 1]];
const componentDistanceMeters = (
  lines: ReadonlyArray<ReadonlyArray<Position>>,
  component: ReadonlyArray<number>,
  point: Position,
): number =>
  Math.min(
    ...component.map((index) => lineDistanceMeters(lines[index], point)),
  );
function lineDistanceMeters(
  line: ReadonlyArray<Position>,
  point: Position,
): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return pointDistanceMeters(line[0], point);
  let closest = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    closest = Math.min(
      closest,
      segmentDistanceMeters(point, line[i - 1], line[i]),
    );
  }
  return closest;
}
function segmentDistanceMeters(
  point: Position,
  start: Position,
  end: Position,
): number {
  const x0 = lonToMeters(point.lng, point.lat),
    y0 = latToMeters(point.lat),
    x1 = lonToMeters(start.lng, point.lat),
    y1 = latToMeters(start.lat),
    x2 = lonToMeters(end.lng, point.lat),
    y2 = latToMeters(end.lat),
    dx = x2 - x1,
    dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x0 - x1, y0 - y1);
  const t = Math.max(
    0,
    Math.min(1, ((x0 - x1) * dx + (y0 - y1) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(x0 - (x1 + t * dx), y0 - (y1 + t * dy));
}
function pointDistanceMeters(left: Position, right: Position): number {
  const lat = (left.lat + right.lat) / 2;
  return Math.hypot(
    lonToMeters(left.lng - right.lng, lat),
    latToMeters(left.lat - right.lat),
  );
}
const lonToMeters = (delta: number, lat: number): number =>
  (delta * Math.PI * 6371000 * Math.cos((lat * Math.PI) / 180)) / 180;
const latToMeters = (delta: number): number =>
  (delta * Math.PI * 6371000) / 180;
