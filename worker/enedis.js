import { enterSpan } from "./trace.js";
import { sha256Hex } from "./util.js";

export const ENEDIS_ORIGIN = "https://www.enedis.fr";
export const ENEDIS_ENDPOINT = `${ENEDIS_ORIGIN}/panne-interruption-ajax`;
export const ENEDIS_RESULT_PAGE = `${ENEDIS_ORIGIN}/resultat-panne-interruption`;

const ENEDIS_CACHE_VERSION = 1;
const ENEDIS_CACHE_KEY = "enedis:index";
const ENEDIS_CACHE_MAX_ENTRIES = 200;

const DEFAULT_LONGITUDE = "2.347";
const DEFAULT_LATITUDE = "48.859";
const DEFAULT_DEPARTMENT = "75";

export const DEFAULT_QUERY = {
  insee: "75056",
  type: "municipality",
  adresse: "Paris",
  CPVille: "Paris 75001",
  name: "Paris",
  district: "",
  city: "Paris",
};

export class EnedisClient {
  constructor(store, traceCtx, ttlSeconds) {
    this.store = store;
    this.traceCtx = traceCtx;
    this.ttlSeconds = ttlSeconds;
    this.memory = new Map();
    this.loadedStore = false;
    this.loadPromise = null;
    this.dirty = false;
    this.stats = {
      cacheHits: 0,
      upstreamFetches: 0,
    };
  }

  async fetch(query, options = {}) {
    const useCache = options.cache !== false;
    if (!useCache) {
      const payload = await fetchEnedis(query, this.traceCtx);
      this.stats.upstreamFetches += 1;
      return payload;
    }

    const cacheKey = await enedisCacheKey(query);
    await this.loadStore();

    const cached = this.memory.get(cacheKey);
    if (cached && Date.now() < Date.parse(cached.freshUntil)) {
      this.stats.cacheHits += 1;
      return cached.payload;
    }

    const payload = await fetchEnedis(query, this.traceCtx);
    this.stats.upstreamFetches += 1;
    if (this.store && this.ttlSeconds > 0) {
      const now = Date.now();
      this.memory.set(cacheKey, {
        query: cacheableQuery(query),
        payload,
        fetchedAt: new Date(now).toISOString(),
        freshUntil: new Date(now + this.ttlSeconds * 1000).toISOString(),
      });
      this.dirty = true;
    }
    return payload;
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
      cached = await this.store.get(ENEDIS_CACHE_KEY, { cacheTtl: 60 });
    } catch (error) {
      console.warn(`read Enedis cache: ${error.message || error}`);
      return;
    }
    if (!cached.found || cached.value?.version !== ENEDIS_CACHE_VERSION || !cached.value.entries) return;

    const now = Date.now();
    for (const [key, entry] of Object.entries(cached.value.entries)) {
      if (!entry?.payload || Date.parse(entry.freshUntil) <= now) continue;
      this.memory.set(key, entry);
    }
  }

  async save() {
    if (!this.store || !this.dirty || this.ttlSeconds <= 0) return;

    const now = Date.now();
    const entries = [...this.memory.entries()]
      .filter(([, entry]) => Date.parse(entry.freshUntil) > now)
      .sort((left, right) => Date.parse(right[1].fetchedAt) - Date.parse(left[1].fetchedAt))
      .slice(0, ENEDIS_CACHE_MAX_ENTRIES);

    this.dirty = false;
    try {
      await this.store.set(
        ENEDIS_CACHE_KEY,
        {
          version: ENEDIS_CACHE_VERSION,
          updatedAt: new Date().toISOString(),
          entries: Object.fromEntries(entries),
        },
        { expirationTtl: Math.max(this.ttlSeconds, 60) },
      );
    } catch (error) {
      console.warn(`write Enedis cache: ${error.message || error}`);
    }
  }
}

export function queryFromValues(values) {
  const query = { ...DEFAULT_QUERY };
  copyParam(values, query, "insee", "insee");
  copyParam(values, query, "type", "type");
  copyParam(values, query, "adresse", "adresse");
  copyParam(values, query, "CPVille", "CPVille");
  copyParam(values, query, "name", "name");
  copyParam(values, query, "district", "district");
  copyParam(values, query, "city", "city");
  copyParam(values, query, "long", "longitude");
  copyParam(values, query, "longitude", "longitude");
  copyParam(values, query, "lat", "latitude");
  copyParam(values, query, "latitude", "latitude");
  copyParam(values, query, "departement", "department");
  copyParam(values, query, "department", "department");
  return query;
}

async function enedisCacheKey(query) {
  return sha256Hex(JSON.stringify(cacheableQuery(query)));
}

function cacheableQuery(query) {
  return {
    insee: query.insee || "",
    type: query.type || "",
    adresse: query.adresse || "",
    CPVille: query.CPVille || "",
    name: query.name || "",
    district: query.district || "",
    city: query.city || "",
  };
}

export async function fetchEnedis(query, traceCtx) {
  return enterSpan(traceCtx, "enedis.fetch", { "enedis.insee": query.insee, "enedis.city": query.city }, async (span) => {
    const endpoint = new URL(ENEDIS_ENDPOINT);
    endpoint.searchParams.set("insee", query.insee || "");
    endpoint.searchParams.set("type", query.type || "");
    endpoint.searchParams.set("adresse", query.adresse || "");
    endpoint.searchParams.set("CPVille", query.CPVille || "");
    endpoint.searchParams.set("name", query.name || "");
    endpoint.searchParams.set("district", query.district || "");
    endpoint.searchParams.set("city", query.city || "");

    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: resultURL(query),
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      },
    });
    span.setAttribute("http.response.status_code", response.status);

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Enedis returned ${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`decode Enedis JSON: ${error.message}`);
    }
  });
}

export function resultURL(query) {
  const url = new URL(ENEDIS_RESULT_PAGE);
  url.searchParams.set("adresse", query.adresse || "");
  url.searchParams.set("insee", query.insee || "");
  url.searchParams.set("long", query.longitude || DEFAULT_LONGITUDE);
  url.searchParams.set("lat", query.latitude || DEFAULT_LATITUDE);
  url.searchParams.set("type", query.type || "");
  url.searchParams.set("CPVille", query.CPVille || "");
  url.searchParams.set("street", "");
  url.searchParams.set("name", query.name || "");
  url.searchParams.set("departement", query.department || DEFAULT_DEPARTMENT);
  url.searchParams.set("district", query.district || "");
  url.searchParams.set("city", query.city || "");
  return url.toString();
}

function copyParam(values, target, sourceName, targetName) {
  if (values.has(sourceName)) target[targetName] = values.get(sourceName);
}
