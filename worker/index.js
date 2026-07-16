import { KVJSONStore } from "./cache.js";
import { boundsForCommune, cachedCommunesForBounds, enedisQueryForCommune } from "./communes.js";
import { area, height, parseBounds, width } from "./geo.js";
import { EnedisClient, queryFromValues } from "./enedis.js";
import { Geocoder } from "./geocode.js";
import { mergeOutageResponses, Normalizer, responseCommunes } from "./outages.js";
import { StreetGeometryProvider } from "./streetgeom.js";
import { enterSpan } from "./trace.js";
import { mapLimit, parseDuration, sha256Hex } from "./util.js";

const MAX_VIEWPORT_AREA = 0.35;
const MAX_VIEWPORT_SPAN = 1.0;
const MAX_VIEWPORT_COMMUNES = 30;
const CACHE_ENTRY_VERSION = 4;
const COMMUNE_OUTAGE_CACHE_VERSION = 2;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    return enterSpan(ctx, "request", { "http.request.method": request.method, "url.path": url.pathname }, async (span) => {
      try {
        if (url.pathname === "/api/health") {
          span.setAttribute("route", "/api/health");
          return json({ ok: true });
        }
        if (url.pathname === "/api/outages") {
          span.setAttribute("route", "/api/outages");
          return handleOutages(request, env, ctx);
        }
        return env.ASSETS.fetch(request);
      } catch (error) {
        console.error(error);
        return json({ error: "INTERNAL_ERROR", message: error.message || "unexpected error" }, 500);
      }
    });
  },
};

async function handleOutages(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "METHOD_NOT_ALLOWED", message: "method not allowed" }, 405);
  }

  const url = new URL(request.url);
  const parsed = parseBounds(url.searchParams);
  if (parsed.error) {
    return json({ error: "INVALID_VIEWPORT", message: parsed.error }, 400);
  }

  const runtime = runtimeConfig(env, ctx);
  if (parsed.hasBounds) {
    return viewportOutages(request, parsed.bounds, runtime, ctx);
  }
  return singleOutages(request, runtime, ctx);
}

async function singleOutages(request, runtime, ctx) {
  const url = new URL(request.url);
  const query = queryFromValues(url.searchParams);
  const includeRaw = url.searchParams.get("raw") === "1";
  const shouldGeocode = url.searchParams.get("geocode") !== "0";
  const cacheKey = await outageCacheKey(query, includeRaw, shouldGeocode);
  const refresh = async () => fetchSingleOutages(query, includeRaw, shouldGeocode, runtime);
  return serveCachedOutage(request, cacheKey, refresh, runtime, ctx, "single");
}

async function viewportOutages(request, bounds, runtime, ctx) {
  if (area(bounds) > MAX_VIEWPORT_AREA || height(bounds) > MAX_VIEWPORT_SPAN || width(bounds) > MAX_VIEWPORT_SPAN) {
    return json({ error: "VIEWPORT_TOO_LARGE", message: "viewport is too large; zoom in" }, 400);
  }

  const url = new URL(request.url);
  const includeRaw = url.searchParams.get("raw") === "1";
  const shouldGeocode = url.searchParams.get("geocode") !== "0";
  try {
    const response = await fetchViewportOutages(bounds, includeRaw, shouldGeocode, runtime);
    const httpResponse = json(response);
    httpResponse.headers.set("X-App-Cache", "COMMUNE");
    return httpResponse;
  } catch (error) {
    return responseError(error, 502, "ENEDIS_FETCH_FAILED");
  }
}

async function fetchSingleOutages(query, includeRaw, shouldGeocode, runtime) {
  const raw = await runtime.enedis.fetch(query);
  await runtime.enedis.save();
  const response = await runtime.normalizer.normalize(raw, query, shouldGeocode);
  if (includeRaw) response.raw = raw;
  return response;
}

async function fetchViewportOutages(bounds, includeRaw, shouldGeocode, runtime) {
  const visibleCommunes = await cachedCommunesForBounds(
    bounds,
    MAX_VIEWPORT_COMMUNES,
    runtime.cache,
    runtime.traceCtx,
    runtime.communesCacheTTL,
  );
  const { responses, warnings } = await fetchVisibleCommuneOutages(visibleCommunes, shouldGeocode, bounds, runtime);
  if (responses.length === 0 && warnings.length > 0) {
    const error = new Error("all visible commune requests failed");
    error.status = 502;
    error.code = "ENEDIS_FETCH_FAILED";
    error.warnings = warnings;
    throw error;
  }

  const response = mergeOutageResponses(responses);
  response.viewport = bounds;
  response.communes = responseCommunes(visibleCommunes);
  response.warnings = warnings;
  if (includeRaw) {
    response.warnings = [...(response.warnings || []), "raw Enedis payloads are omitted for viewport aggregation"];
  }
  return response;
}

async function fetchVisibleCommuneOutages(communes, shouldGeocode, fallbackBounds, runtime) {
  return enterSpan(runtime.traceCtx, "outages.fetch_visible_commune_facts", { "communes.count": communes.length }, async (span) => {
    const results = await mapLimit(communes, 6, async (commune) => {
      try {
        return {
          response: await fetchCachedCommuneOutage(commune, shouldGeocode, fallbackBounds, runtime),
        };
      } catch (error) {
        return {
          warning: `${commune.name} (${commune.code}): ${error.message}`,
        };
      }
    });
    const responses = results.filter((result) => result.response).map((result) => result.response);
    const warnings = results.filter((result) => result.warning).map((result) => result.warning);
    span.setAttribute("communes.responses", responses.length);
    span.setAttribute("communes.warnings", warnings.length);
    return { responses, warnings };
  });
}

async function fetchCachedCommuneOutage(commune, shouldGeocode, fallbackBounds, runtime) {
  const cacheKey = await communeOutageCacheKey(commune, shouldGeocode);
  if (runtime.cache && runtime.outageCacheTTL > 0) {
    const cached = await runtime.cache.get(cacheKey, { cacheTtl: 60 });
    if (cached.found && cached.value?.version === COMMUNE_OUTAGE_CACHE_VERSION && Date.now() < Date.parse(cached.value.freshUntil)) {
      return cached.value.response;
    }
  }

  const query = enedisQueryForCommune(commune);
  const raw = await runtime.enedis.fetch(query, { cache: false });
  const response = await runtime.normalizer.normalizeSet([{ raw, query }], { geocode: shouldGeocode, geometry: false });
  const geometryBounds = boundsForCommune(commune, fallbackBounds);
  if (shouldGeocode && geometryBounds) {
    await runtime.normalizer.attachGeometryToResponse(response, geometryBounds);
  }
  response.commune = responseCommunes([commune])[0];
  const cacheResponse = compactEmptyCommuneResponse(response);

  if (runtime.cache && runtime.outageCacheTTL > 0) {
    const now = Date.now();
    await runtime.cache.set(
      cacheKey,
      {
        version: COMMUNE_OUTAGE_CACHE_VERSION,
        refreshedAt: new Date(now).toISOString(),
        freshUntil: new Date(now + runtime.outageCacheTTL * 1000).toISOString(),
        response: cacheResponse,
      },
      { expirationTtl: outageRetentionTTL(runtime) },
    );
  }
  return cacheResponse;
}

async function serveCachedOutage(request, cacheKey, refresh, runtime, ctx, kind) {
  if (!runtime.outageCache || runtime.outageCacheTTL <= 0) {
    return refreshAndRespond(cacheKey, refresh, runtime, "MISS");
  }

  const cached = await readOutageCache(cacheKey, runtime);
  if (cached.found) {
    const now = Date.now();
    if (now < Date.parse(cached.entry.freshUntil)) {
      return responseWithCacheHeaders(cached.entry.response, "HIT", cached.entry);
    }

    ctx.waitUntil(
      enterSpan(ctx, "outages.refresh_stale", { "outages.kind": kind }, async () => {
        const response = await refresh();
        await storeOutageCache(cacheKey, response, runtime);
      }).catch((error) => console.error(`refresh outages cache ${cacheKey}:`, error)),
    );
    const response = responseWithCacheHeaders(cached.entry.response, "STALE", cached.entry);
    response.headers.set("X-App-Cache-Refresh", "background");
    return response;
  }

  return refreshAndRespond(cacheKey, refresh, runtime, "MISS");
}

async function refreshAndRespond(cacheKey, refresh, runtime, cacheStatus) {
  try {
    const response = await refresh();
    await storeOutageCache(cacheKey, response, runtime);
    const httpResponse = json(response);
    httpResponse.headers.set("X-App-Cache", cacheStatus);
    return httpResponse;
  } catch (error) {
    return responseError(error, 502, "ENEDIS_FETCH_FAILED");
  }
}

async function readOutageCache(cacheKey, runtime) {
  const cached = await runtime.outageCache.get(cacheKey, { cacheTtl: 60 });
  if (!cached.found || cached.value?.version !== CACHE_ENTRY_VERSION) {
    return { found: false, entry: null };
  }
  return { found: true, entry: cached.value };
}

async function storeOutageCache(cacheKey, response, runtime) {
  if (!runtime.outageCache || runtime.outageCacheTTL <= 0) return;
  const now = new Date();
  const entry = {
    version: CACHE_ENTRY_VERSION,
    response,
    refreshedAt: now.toISOString(),
    freshUntil: new Date(now.getTime() + runtime.outageCacheTTL * 1000).toISOString(),
  };
  await runtime.outageCache.set(cacheKey, entry, { expirationTtl: outageRetentionTTL(runtime) });
}

function outageRetentionTTL(runtime) {
  return Math.max(runtime.outageCacheTTL, runtime.outageStaleTTL);
}

function responseWithCacheHeaders(payload, status, entry) {
  const response = json(payload);
  response.headers.set("X-App-Cache", status);
  response.headers.set("X-App-Cache-Refreshed-At", entry.refreshedAt);
  response.headers.set("X-App-Cache-Fresh-Until", entry.freshUntil);
  return response;
}

function responseError(error, fallbackStatus, fallbackCode) {
  const status = error.status || fallbackStatus;
  return json(
    {
      error: error.code || fallbackCode,
      message: error.message || "request failed",
      warnings: error.warnings,
    },
    status,
  );
}

async function outageCacheKey(query, includeRaw, shouldGeocode) {
  const payload = JSON.stringify({
    kind: "single",
    query,
    includeRaw,
    shouldGeocode,
  });
  return `outages:${await sha256Hex(payload)}`;
}

async function communeOutageCacheKey(commune, shouldGeocode) {
  const payload = JSON.stringify({
    version: COMMUNE_OUTAGE_CACHE_VERSION,
    kind: "commune",
    code: commune.code || "",
    shouldGeocode,
  });
  return `commune-outages:${await sha256Hex(payload)}`;
}

function compactEmptyCommuneResponse(response) {
  if (response?.stats?.outages !== 0 || response?.stats?.streets !== 0) return response;
  return {
    updatedAt: response.updatedAt,
    source: response.source,
    query: response.query,
    stats: response.stats,
    outages: [],
    streets: [],
    recap: response.recap,
    crises: response.crises,
    commune: response.commune,
  };
}

function runtimeConfig(env, ctx) {
  const prefix = env.CACHE_PREFIX || "enedis-carte-coupure";
  const cache = env.CACHE ? new KVJSONStore(env.CACHE, prefix, ctx) : null;
  const outageCacheTTL = parseDuration(env.OUTAGE_CACHE_TTL, 15 * 60);
  const geocoder = new Geocoder(cache, ctx);
  const geometries = new StreetGeometryProvider(cache, ctx);
  const normalizer = new Normalizer(geocoder, geometries, ctx);
  const enedis = new EnedisClient(cache, ctx, parseDuration(env.ENEDIS_CACHE_TTL, Math.min(outageCacheTTL, 5 * 60)));
  return {
    traceCtx: ctx,
    cache,
    enedis,
    outageCache: cache,
    outageCacheTTL,
    outageStaleTTL: parseDuration(env.OUTAGE_CACHE_STALE_TTL, 24 * 60 * 60),
    communesCacheTTL: parseDuration(env.COMMUNES_CACHE_TTL, 7 * 24 * 60 * 60),
    normalizer,
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const testExports = {
  outageCacheKey,
  runtimeConfig,
};
