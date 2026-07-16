import { enterSpan } from "./trace.js";
import { stripAccents } from "./util.js";

export const GEOCODE_PRIMARY_ENDPOINT = "https://data.geopf.fr/geocodage/search";
export const GEOCODE_FALLBACK_ENDPOINT = "https://api-adresse.data.gouv.fr/search/";

export class Geocoder {
  store: any;
  traceCtx: any;
  memory: Map<string, any>;
  loadedStore: boolean;
  dirty: boolean;

  constructor(store: any, traceCtx?: any) {
    this.store = store;
    this.traceCtx = traceCtx;
    this.memory = new Map();
    this.loadedStore = false;
    this.dirty = false;
  }

  async street(query) {
    query = String(query || "").trim();
    const key = geocodeKey(query);
    await this.loadStore();
    if (this.memory.has(key)) {
      return markCached(this.memory.get(key));
    }

    let result;
    try {
      result = await this.lookup(GEOCODE_PRIMARY_ENDPOINT, query);
      if (result.status !== "ok") {
        result = await this.lookup(GEOCODE_FALLBACK_ENDPOINT, query);
      }
    } catch (error) {
      try {
        result = await this.lookup(GEOCODE_FALLBACK_ENDPOINT, query);
      } catch (fallbackError) {
        return { status: "error", query, message: fallbackError.message || error.message, cached: false };
      }
    }

    if (result.status === "ok" || result.status === "miss") {
      this.memory.set(key, result);
      this.dirty = true;
    }
    return { ...result, cached: false };
  }

  async loadStore() {
    if (!this.store || this.loadedStore) return;
    this.loadedStore = true;
    const cached = await this.store.get("geocode:index", { cacheTtl: 3600 });
    if (!cached.found || !cached.value || typeof cached.value !== "object") return;
    for (const [key, result] of Object.entries(cached.value) as Array<[string, any]>) {
      if (result?.status === "error") continue;
      this.memory.set(key, result);
    }
  }

  async save() {
    if (!this.store || !this.dirty) return;
    const payload: Record<string, any> = {};
    for (const [key, result] of this.memory) {
      const { cached, ...publicResult } = result;
      if (publicResult.status === "error") continue;
      payload[key] = publicResult;
    }
    this.dirty = false;
    await this.store.set("geocode:index", payload);
  }

  async lookup(endpoint, query) {
    return enterSpan(this.traceCtx, "geocode.lookup", { "geocode.endpoint": endpoint }, async (span) => {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "1");

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "enedis-carte-coupure/1.0",
        },
      });
      span.setAttribute("http.response.status_code", response.status);
      if (!response.ok) {
        throw new Error(`${endpoint} returned ${response.status} ${response.statusText}`);
      }

      const decoded: any = await response.json();
      const feature = decoded.features?.[0];
      if (!feature?.geometry?.coordinates || feature.geometry.coordinates.length < 2) {
        return { status: "miss", query };
      }
      return {
        status: "ok",
        query,
        lng: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1],
        label: feature.properties?.label || "",
        score: feature.properties?.score,
        type: feature.properties?.type || "",
        postcode: feature.properties?.postcode || "",
        citycode: feature.properties?.citycode || "",
      };
    });
  }
}

export function geocodeKey(query) {
  return stripAccents(String(query || "").trim()).toUpperCase();
}

export function publicGeocode(result) {
  if (!result) return null;
  const { cached, ...publicResult } = result;
  return publicResult;
}

function markCached(result) {
  return { ...result, cached: true };
}
