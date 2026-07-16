import { boundsCacheKey, boundsFromGeoJSONGeometry, center, padded, snapped } from "./geo.js";
import { enterSpan } from "./trace.js";
import { mapLimit } from "./util.js";

export const COMMUNES_ENDPOINT = "https://geo.api.gouv.fr/communes";

const LOOKUP_CONCURRENCY = 8;
const COMMUNES_CACHE_VERSION = 2;
const COMMUNE_POINT_INDEX_VERSION = 1;
const COMMUNE_POINT_INDEX_KEY = "communes:points";
const COMMUNE_POINT_INDEX_MAX_ENTRIES = 2500;
const COMMUNES_VIEWPORT_GRID = 0.02;
const COMMUNE_GEOMETRY_PADDING_RATIO = 0.04;
const pointCache = new Map();

export async function cachedCommunesForBounds(bounds, maxCommunes, store, traceCtx, ttlSeconds) {
  if (!store || ttlSeconds <= 0) {
    return communesForBounds(bounds, maxCommunes, traceCtx);
  }

  const cacheBounds = snapped(bounds, COMMUNES_VIEWPORT_GRID);
  const cacheKey = `communes:${boundsCacheKey(cacheBounds)}`;
  try {
    const cached = await store.get(cacheKey, { cacheTtl: 3600 });
    if (cached.found && cached.value?.version === COMMUNES_CACHE_VERSION && Array.isArray(cached.value.communes)) {
      return cached.value.communes;
    }
  } catch (error) {
    console.warn(`read communes cache: ${error.message || error}`);
  }

  const pointIndex = new CommunePointIndex(store, traceCtx, ttlSeconds);
  const communes = await communesForBounds(bounds, maxCommunes, traceCtx, pointIndex);
  await pointIndex.save();
  try {
    await store.set(
      cacheKey,
      {
        version: COMMUNES_CACHE_VERSION,
        bounds: cacheBounds,
        updatedAt: new Date().toISOString(),
        communes,
      },
      { expirationTtl: ttlSeconds },
    );
  } catch (error) {
    console.warn(`write communes cache: ${error.message || error}`);
  }
  return communes;
}

export async function communesForBounds(bounds, maxCommunes, traceCtx, pointIndex: CommunePointIndex | null = null) {
  return enterSpan(traceCtx, "communes.for_bounds", { "viewport.max_communes": maxCommunes }, async (span) => {
    const points = samplePoints(bounds);
    span.setAttribute("communes.sample_points", points.length);
    await pointIndex?.loadStore();

    const results = await mapLimit(points, LOOKUP_CONCURRENCY, async (point) => {
      const cached = await pointIndex?.get(point);
      if (cached) return cached;
      const result = await lookupPoint(point, traceCtx);
      if (!result.error) await pointIndex?.set(point, result);
      return result;
    });
    const seen = new Map();
    let lastError = null;
    for (const result of results) {
      if (result.error) {
        lastError = result.error;
        continue;
      }
      if (result.found && result.commune?.code && !seen.has(result.commune.code)) {
        seen.set(result.commune.code, result.commune);
      }
    }
    if (maxCommunes > 0 && seen.size > maxCommunes) {
      throw new Error(`viewport covers more than ${maxCommunes} communes; zoom in`);
    }
    const communes = [...seen.values()].sort((left, right) => left.code.localeCompare(right.code));
    span.setAttribute("communes.count", communes.length);
    if (pointIndex) {
      span.setAttribute("communes.point_cache_hits", pointIndex.stats.cacheHits);
      span.setAttribute("communes.point_contour_hits", pointIndex.stats.contourHits);
      span.setAttribute("communes.point_upstream_fetches", pointIndex.stats.upstreamFetches);
    }
    if (communes.length === 0 && lastError) throw lastError;
    return communes;
  });
}

class CommunePointIndex {
  store: any;
  traceCtx: any;
  ttlSeconds: number;
  memory: Map<string, any>;
  loadedStore: boolean;
  loadPromise: Promise<void> | null;
  dirty: boolean;
  stats: { cacheHits: number; contourHits: number; upstreamFetches: number };

  constructor(store: any, traceCtx: any, ttlSeconds: number) {
    this.store = store;
    this.traceCtx = traceCtx;
    this.ttlSeconds = ttlSeconds;
    this.memory = new Map();
    this.loadedStore = false;
    this.loadPromise = null;
    this.dirty = false;
    this.stats = {
      cacheHits: 0,
      contourHits: 0,
      upstreamFetches: 0,
    };
  }

  async get(point) {
    if (!this.store || this.ttlSeconds <= 0) return null;
    await this.loadStore();

    const key = pointKey(point);
    const exact = this.memory.get(key);
    if (exact) {
      this.stats.cacheHits += 1;
      return exact;
    }

    for (const result of this.memory.values()) {
      if (result?.found && result.commune?.contour && pointInGeometry(point, result.commune.contour)) {
        this.stats.contourHits += 1;
        this.memory.set(key, result);
        pointCache.set(key, result);
        this.dirty = true;
        return result;
      }
    }
    return null;
  }

  async set(point, result) {
    if (!this.store || this.ttlSeconds <= 0 || result?.error) return;
    this.stats.upstreamFetches += 1;
    const key = pointKey(point);
    this.memory.set(key, compactPointResult(result));
    this.dirty = true;
  }

  async loadStore() {
    if (!this.store || this.loadedStore) return;
    if (!this.loadPromise) {
      this.loadPromise = this.readStore();
    }
    await this.loadPromise;
  }

  async readStore() {
    this.loadedStore = true;
    let cached;
    try {
      cached = await this.store.get(COMMUNE_POINT_INDEX_KEY, { cacheTtl: 3600 });
    } catch (error) {
      console.warn(`read commune point cache: ${error.message || error}`);
      return;
    }
    if (!cached.found || cached.value?.version !== COMMUNE_POINT_INDEX_VERSION || !cached.value.entries) return;

    for (const [key, result] of Object.entries(cached.value.entries)) {
      if (!validPointResult(result)) continue;
      this.memory.set(key, result);
      pointCache.set(key, result);
    }
  }

  async save() {
    if (!this.store || !this.dirty || this.ttlSeconds <= 0) return;
    const entries = [...this.memory.entries()].slice(-COMMUNE_POINT_INDEX_MAX_ENTRIES);
    this.dirty = false;
    try {
      await this.store.set(
        COMMUNE_POINT_INDEX_KEY,
        {
          version: COMMUNE_POINT_INDEX_VERSION,
          updatedAt: new Date().toISOString(),
          entries: Object.fromEntries(entries),
        },
        { expirationTtl: this.ttlSeconds },
      );
    } catch (error) {
      console.warn(`write commune point cache: ${error.message || error}`);
    }
  }
}

export function enedisQueryForCommune(commune) {
  const postcode = commune.postcodes?.[0] || "";
  const query: Record<string, any> = {
    insee: commune.code,
    type: "municipality",
    adresse: commune.name,
    CPVille: `${commune.name} ${postcode}`.trim(),
    name: commune.name,
    district: "",
    city: commune.name,
    department: departmentFromCode(commune.code),
  };
  if (commune.center?.coordinates?.length >= 2) {
    query.longitude = commune.center.coordinates[0].toFixed(6);
    query.latitude = commune.center.coordinates[1].toFixed(6);
  }
  return query;
}

export async function fetchVisibleCommunes(communes: any[], enedis: any, traceCtx: any) {
  return enterSpan(traceCtx, "enedis.fetch_visible_communes", { "communes.count": communes.length }, async (span) => {
    const before = { ...enedis.stats };
    const results = await mapLimit(communes, 6, async (commune) => {
      const query = enedisQueryForCommune(commune);
      try {
        return {
          input: { raw: await enedis.fetch(query), query },
        };
      } catch (error) {
        return {
          warning: `${commune.name} (${commune.code}): ${error.message}`,
        };
      }
    });

    const inputs = results.filter((result) => result.input).map((result) => result.input);
    const warnings = results.filter((result) => result.warning).map((result) => result.warning);
    span.setAttribute("enedis.inputs", inputs.length);
    span.setAttribute("enedis.warnings", warnings.length);
    span.setAttribute("enedis.cache_hits", enedis.stats.cacheHits - before.cacheHits);
    span.setAttribute("enedis.upstream_fetches", enedis.stats.upstreamFetches - before.upstreamFetches);
    return { inputs, warnings };
  });
}

function samplePoints(bounds) {
  const points = [center(bounds)];
  const seen = new Set([pointKey(points[0])]);
  const grid = 3;
  for (let latIndex = 0; latIndex < grid; latIndex += 1) {
    const lat = interpolate(bounds.south, bounds.north, latIndex, grid);
    for (let lngIndex = 0; lngIndex < grid; lngIndex += 1) {
      const lng = interpolate(bounds.west, bounds.east, lngIndex, grid);
      const point = { lat, lng };
      const key = pointKey(point);
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(point);
    }
  }
  return points;
}

async function lookupPoint(point, traceCtx) {
  const key = pointKey(point);
  if (pointCache.has(key)) {
    return pointCache.get(key);
  }

  return enterSpan(traceCtx, "communes.lookup_point", { "geo.lat": point.lat, "geo.lng": point.lng }, async (span) => {
    try {
      const url = new URL(COMMUNES_ENDPOINT);
      url.searchParams.set("lat", point.lat.toFixed(6));
      url.searchParams.set("lon", point.lng.toFixed(6));
      url.searchParams.set("fields", "nom,code,codesPostaux,centre,contour");
      url.searchParams.set("format", "json");

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "enedis-carte-coupure/1.0",
        },
      });
      span.setAttribute("http.response.status_code", response.status);
      if (!response.ok) {
        throw new Error(`${COMMUNES_ENDPOINT} returned ${response.status} ${response.statusText}`);
      }
      const decoded = await response.json();
      const first = decoded[0];
      const result = first?.code
        ? {
            found: true,
            commune: {
              name: first.nom,
              code: first.code,
              postcodes: first.codesPostaux || [],
              center: first.centre || {},
              contour: first.contour || null,
            },
          }
        : { found: false, commune: null };
      pointCache.set(key, result);
      return result;
    } catch (error) {
      return { found: false, commune: null, error };
    }
  });
}

function interpolate(min, max, index, count) {
  if (count <= 1) return (min + max) / 2;
  return min + ((max - min) * index) / (count - 1);
}

function pointKey(point) {
  return `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

function compactPointResult(result) {
  if (!result?.found) return { found: false, commune: null };
  return {
    found: true,
    commune: {
      name: result.commune?.name || "",
      code: result.commune?.code || "",
      postcodes: result.commune?.postcodes || [],
      center: result.commune?.center || {},
      contour: result.commune?.contour || null,
    },
  };
}

function validPointResult(result) {
  return result?.found === false || (result?.found === true && Boolean(result.commune?.code));
}

function pointInGeometry(point, geometry) {
  if (geometry?.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates);
  }
  if (geometry?.type === "MultiPolygon") {
    return (geometry.coordinates || []).some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

function pointInPolygon(point, rings) {
  if (!rings?.length || !pointInRing(point, rings[0])) return false;
  return !(rings.slice(1) || []).some((ring) => pointInRing(point, ring));
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    const currentLng = currentPoint[0];
    const currentLat = currentPoint[1];
    const previousLng = previousPoint[0];
    const previousLat = previousPoint[1];
    if (!Number.isFinite(currentLat) || !Number.isFinite(currentLng) || !Number.isFinite(previousLat) || !Number.isFinite(previousLng)) {
      continue;
    }
    const intersects =
      currentLat > point.lat !== previousLat > point.lat &&
      point.lng < ((previousLng - currentLng) * (point.lat - currentLat)) / (previousLat - currentLat) + currentLng;
    if (intersects) inside = !inside;
  }
  return inside;
}

function departmentFromCode(code) {
  if (code.length >= 3 && (code.startsWith("97") || code.startsWith("98"))) return code.slice(0, 3);
  if (code.length >= 2) return code.slice(0, 2);
  return code;
}

export function boundsForCommune(commune, fallbackBounds = null) {
  const contourBounds = boundsFromGeoJSONGeometry(commune?.contour);
  if (contourBounds) return padded(contourBounds, COMMUNE_GEOMETRY_PADDING_RATIO);
  if (fallbackBounds) return fallbackBounds;
  if (commune?.center?.coordinates?.length >= 2) {
    const lng = commune.center.coordinates[0];
    const lat = commune.center.coordinates[1];
    return {
      south: lat - 0.03,
      west: lng - 0.03,
      north: lat + 0.03,
      east: lng + 0.03,
    };
  }
  return null;
}
