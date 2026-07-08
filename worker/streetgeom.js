import { boundsCacheKey, overpassBBox, padded, snapped } from "./geo.js";
import { enterSpan } from "./trace.js";
import { stripAccents, uniqueSorted } from "./util.js";

export const STREET_GEOMETRY_PRIMARY_ENDPOINT = "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
export const STREET_GEOMETRY_FALLBACK_ENDPOINT = "https://lz4.overpass-api.de/api/interpreter";

const CACHE_FILE_VERSION = 3;
const DEFAULT_INDEX_KEY = "paris";
const VIEWPORT_INDEX_PREFIX = "streets:";
const VIEWPORT_PADDING_RATIO = 0.08;
const VIEWPORT_SNAP_GRID = 0.005;
const REDIS_INDEX_TTL_SECONDS = 24 * 60 * 60;
const MAX_NAME_REGEX_BATCH_SIZE = 36;
const MAX_POINT_MATCH_METERS = 1800;
const POINT_MATCH_SLACK_METERS = 350;
const COMPONENT_JOIN_METERS = 35;

export class StreetGeometryProvider {
  constructor(store, traceCtx) {
    this.store = store;
    this.traceCtx = traceCtx;
    this.indexes = new Map();
    this.loadedStore = new Set();
  }

  async streetRequests(requests) {
    return this.streetRequestsForIndex(requests, defaultBounds(), DEFAULT_INDEX_KEY);
  }

  async streetRequestsInBounds(requests, bounds) {
    const indexBounds = snapped(padded(bounds, VIEWPORT_PADDING_RATIO), VIEWPORT_SNAP_GRID);
    return this.streetRequestsForIndex(requests, indexBounds, `${VIEWPORT_INDEX_PREFIX}${boundsCacheKey(indexBounds)}`);
  }

  async streetRequestsForIndex(requests, bounds, indexKey) {
    return enterSpan(this.traceCtx, "streetgeom.requests", { "streetgeom.index": indexKey, "streetgeom.requests": requests.length }, async (span) => {
      const requested = requestedRequests(requests);
      if (requested.size === 0) return {};

      let index = this.indexes.get(indexKey) || emptyIndex(bounds);
      let missing = missingKeys(index.streets, requested);
      if (missing.length > 0 && this.store && !this.loadedStore.has(indexKey)) {
        await this.loadStore(indexKey);
        index = this.indexes.get(indexKey) || emptyIndex(bounds);
        missing = missingKeys(index.streets, requested);
      }

      span.setAttribute("streetgeom.missing", missing.length);
      if (missing.length > 0) {
        await this.refresh(bounds, indexKey, missing);
      }

      index = this.indexes.get(indexKey) || emptyIndex(bounds);
      const results = {};
      for (const [resultKey, request] of requested) {
        const nameKey = streetKey(request.name);
        let result = index.streets[nameKey];
        if (!result) {
          result = {
            status: "miss",
            query: request.name,
            updatedAt: index.updatedAt,
          };
          index.streets[nameKey] = result;
        }
        result = { ...result, query: request.name };
        if (request.point) {
          result = filterResultNearPoint(result, request.point);
          result.query = request.name;
        }
        results[resultKey] = result;
      }
      this.indexes.set(indexKey, index);
      return results;
    });
  }

  async loadStore(indexKey) {
    if (!this.store || this.loadedStore.has(indexKey)) return;
    const loaded = await this.store.get(`streetgeom:${indexKey}`, { cacheTtl: 3600 });
    this.loadedStore.add(indexKey);
    if (!loaded.found || !loaded.value?.streets || loaded.value.version !== CACHE_FILE_VERSION) return;
    this.indexes.set(indexKey, loaded.value);
  }

  async refresh(bounds, indexKey, nameKeys) {
    const { grouped, source } = await this.fetch(bounds, nameKeys);
    const now = new Date().toISOString();
    for (const result of Object.values(grouped)) {
      result.updatedAt = now;
    }

    const index = this.indexes.get(indexKey) || emptyIndex(bounds);
    index.version = CACHE_FILE_VERSION;
    index.updatedAt = now;
    index.source = source;
    index.bounds = bounds;
    index.streets ||= {};
    for (const [key, result] of Object.entries(grouped)) {
      index.streets[key] = result;
    }
    this.indexes.set(indexKey, index);
    await this.store?.set(`streetgeom:${indexKey}`, index, { expirationTtl: REDIS_INDEX_TTL_SECONDS });
  }

  async fetch(bounds, nameKeys) {
    let lastError;
    for (const endpoint of [STREET_GEOMETRY_PRIMARY_ENDPOINT, STREET_GEOMETRY_FALLBACK_ENDPOINT]) {
      try {
        return {
          grouped: await this.lookup(endpoint, bounds, nameKeys),
          source: endpoint,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async lookup(endpoint, bounds, nameKeys) {
    return enterSpan(this.traceCtx, "streetgeom.lookup", { "streetgeom.endpoint": endpoint, "streetgeom.names": nameKeys.length }, async (span) => {
      const form = new URLSearchParams();
      form.set("data", buildLookupQuery(bounds, nameKeys));
      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "enedis-carte-coupure/1.0",
        },
      });
      span.setAttribute("http.response.status_code", response.status);
      if (!response.ok) {
        throw new Error(`${endpoint} returned ${response.status} ${response.statusText}`);
      }

      const decoded = await response.json();
      const grouped = {};
      for (const element of decoded.elements || []) {
        if (element.type !== "way" || !element.geometry || element.geometry.length < 2) continue;
        const name = String(element.tags?.name || "").trim();
        const key = streetKey(name);
        if (!key) continue;

        const result = grouped[key] || { status: "ok", source: endpoint, osmNames: [], lines: [] };
        if (!result.osmNames.includes(name)) result.osmNames.push(name);
        result.lines.push(element.geometry.map((point) => ({ lat: point.lat, lng: point.lon })));
        grouped[key] = result;
      }
      for (const result of Object.values(grouped)) {
        result.osmNames.sort((left, right) => left.localeCompare(right));
      }
      span.setAttribute("streetgeom.results", Object.keys(grouped).length);
      return grouped;
    });
  }
}

export function streetKey(value) {
  return stripAccents(String(value || "").trim()).toUpperCase();
}

function emptyIndex(bounds) {
  return { version: CACHE_FILE_VERSION, updatedAt: "", source: "", bounds, streets: {} };
}

function defaultBounds() {
  return { south: 48.815, west: 2.224, north: 48.902, east: 2.47 };
}

function requestedRequests(requests) {
  const requested = new Map();
  for (const request of requests) {
    const name = String(request.name || "").trim();
    const nameKey = streetKey(name);
    if (!nameKey) continue;
    requested.set(String(request.id || "").trim() || nameKey, { ...request, name });
  }
  return requested;
}

function missingKeys(cache, requested) {
  const seen = new Set();
  const missing = [];
  for (const request of requested.values()) {
    const nameKey = streetKey(request.name);
    if (seen.has(nameKey)) continue;
    seen.add(nameKey);
    if (!cache?.[nameKey]) missing.push(nameKey);
  }
  return missing;
}

function buildLookupQuery(bounds, nameKeys) {
  nameKeys = uniqueSorted(nameKeys);
  if (nameKeys.length === 0) {
    return `[out:json][timeout:45];way["highway"]["name"](${overpassBBox(bounds)});out tags geom;`;
  }

  const parts = [];
  for (let start = 0; start < nameKeys.length; start += MAX_NAME_REGEX_BATCH_SIZE) {
    const regexes = nameKeys
      .slice(start, start + MAX_NAME_REGEX_BATCH_SIZE)
      .map(nameRegexFromKey)
      .filter(Boolean);
    if (regexes.length === 0) continue;
    parts.push(`way["highway"]["name"~"^ *(${escapeOverpassRegex(regexes.join("|"))}) *$",i](${overpassBBox(bounds)});`);
  }
  return `[out:json][timeout:45];(${parts.join("")});out tags geom;`;
}

function nameRegexFromKey(nameKey) {
  return String(nameKey || "")
    .trim()
    .split(/\s+/)
    .map(tokenRegex)
    .filter(Boolean)
    .join(`[ ./'’-]+`);
}

function tokenRegex(token) {
  let output = "";
  for (const char of token) {
    switch (char) {
      case "A":
        output += "[AÀÁÂÃÄÅàáâãäå]";
        break;
      case "C":
        output += "[CÇç]";
        break;
      case "E":
        output += "[EÈÉÊËèéêë]";
        break;
      case "I":
        output += "[IÌÍÎÏìíîï]";
        break;
      case "N":
        output += "[NÑñ]";
        break;
      case "O":
        output += "[OÒÓÔÕÖòóôõö]";
        break;
      case "U":
        output += "[UÙÚÛÜùúûü]";
        break;
      case "Y":
        output += "[YÝŸýÿ]";
        break;
      default:
        output += /[A-Z0-9]/.test(char) ? char : escapeRegex(char);
    }
  }
  return output;
}

function escapeOverpassRegex(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeRegex(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function filterResultNearPoint(result, point) {
  if (result.status !== "ok" || !result.lines?.length) return result;

  const components = connectedComponents(result.lines);
  if (components.length === 0) return result;

  const distances = components.map((component) => componentDistanceMeters(result.lines, component, point));
  const closest = Math.min(...distances);
  if (!Number.isFinite(closest) || closest > MAX_POINT_MATCH_METERS) {
    return {
      ...result,
      status: "miss",
      lines: undefined,
      message: `no OSM geometry named ${JSON.stringify(result.query)} within ${MAX_POINT_MATCH_METERS}m of geocoded point`,
    };
  }

  const limit = Math.min(MAX_POINT_MATCH_METERS, closest + POINT_MATCH_SLACK_METERS);
  const filtered = [];
  components.forEach((component, index) => {
    if (distances[index] > limit) return;
    for (const lineIndex of component) filtered.push(result.lines[lineIndex]);
  });
  if (filtered.length === 0) return result;
  return { ...result, lines: filtered };
}

function connectedComponents(lines) {
  const visited = new Array(lines.length).fill(false);
  const components = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (visited[index]) continue;
    visited[index] = true;
    const component = [index];
    const queue = [index];
    while (queue.length > 0) {
      const current = queue.shift();
      for (let candidate = 0; candidate < lines.length; candidate += 1) {
        if (visited[candidate] || !linesTouch(lines[current], lines[candidate])) continue;
        visited[candidate] = true;
        component.push(candidate);
        queue.push(candidate);
      }
    }
    components.push(component);
  }
  return components;
}

function linesTouch(left, right) {
  const leftEndpoints = endpoints(left);
  const rightEndpoints = endpoints(right);
  if (!leftEndpoints || !rightEndpoints) return false;
  for (const leftPoint of leftEndpoints) {
    for (const rightPoint of rightEndpoints) {
      if (pointDistanceMeters(leftPoint, rightPoint) <= COMPONENT_JOIN_METERS) return true;
    }
  }
  return false;
}

function endpoints(line) {
  if (!line?.length) return null;
  return [line[0], line[line.length - 1]];
}

function componentDistanceMeters(lines, component, point) {
  return Math.min(...component.map((lineIndex) => lineDistanceMeters(lines[lineIndex], point)));
}

function lineDistanceMeters(line, point) {
  if (!line?.length) return Number.POSITIVE_INFINITY;
  if (line.length === 1) return pointDistanceMeters(line[0], point);
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < line.length; index += 1) {
    closest = Math.min(closest, segmentDistanceMeters(point, line[index - 1], line[index]));
  }
  return closest;
}

function segmentDistanceMeters(point, start, end) {
  const x0 = lonToMeters(point.lng, point.lat);
  const y0 = latToMeters(point.lat);
  const x1 = lonToMeters(start.lng, point.lat);
  const y1 = latToMeters(start.lat);
  const x2 = lonToMeters(end.lng, point.lat);
  const y2 = latToMeters(end.lat);
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x0 - x1, y0 - y1);
  const t = Math.max(0, Math.min(1, ((x0 - x1) * dx + (y0 - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x0 - (x1 + t * dx), y0 - (y1 + t * dy));
}

function pointDistanceMeters(left, right) {
  const lat = (left.lat + right.lat) / 2;
  return Math.hypot(lonToMeters(left.lng - right.lng, lat), latToMeters(left.lat - right.lat));
}

function lonToMeters(deltaLng, lat) {
  return (deltaLng * Math.PI * 6371000 * Math.cos((lat * Math.PI) / 180)) / 180;
}

function latToMeters(deltaLat) {
  return (deltaLat * Math.PI * 6371000) / 180;
}
