import { enterSpan } from "./trace.js";

export class KVJSONStore {
  constructor(namespace, prefix, traceCtx) {
    this.namespace = namespace;
    this.prefix = String(prefix || "").replace(/^:+|:+$/g, "");
    this.traceCtx = traceCtx;
  }

  async get(key, options = {}) {
    if (!this.namespace) return { found: false, value: null };
    return enterSpan(this.traceCtx, "cache.get", { "cache.key": key, "cache.prefix": this.prefix }, async (span) => {
      const value = await this.namespace.get(this.fullKey(key), {
        type: "json",
        cacheTtl: options.cacheTtl,
      });
      const found = value !== null && value !== undefined;
      span.setAttribute("cache.hit", found);
      return { found, value };
    });
  }

  async set(key, value, options = {}) {
    if (!this.namespace) return;
    await enterSpan(this.traceCtx, "cache.put", { "cache.key": key, "cache.prefix": this.prefix }, async (span) => {
      const putOptions = {};
      if (options.expirationTtl) {
        putOptions.expirationTtl = Math.max(60, Math.ceil(options.expirationTtl));
        span.setAttribute("cache.expiration_ttl", putOptions.expirationTtl);
      }
      await this.namespace.put(this.fullKey(key), JSON.stringify(value), putOptions);
    });
  }

  fullKey(key) {
    const cleaned = String(key || "").trim();
    return this.prefix ? `${this.prefix}:${cleaned}` : cleaned;
  }
}

export class MemoryKVNamespace {
  constructor() {
    this.entries = new Map();
  }

  async get(key, options = {}) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    if (options.type === "json") {
      return JSON.parse(entry.value);
    }
    return entry.value;
  }

  async put(key, value, options = {}) {
    const entry = { value: String(value), expiresAt: 0 };
    if (options.expirationTtl) {
      entry.expiresAt = Date.now() + options.expirationTtl * 1000;
    }
    this.entries.set(key, entry);
  }
}
