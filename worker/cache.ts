import { enterSpan } from "./trace.js";

interface CacheGetOptions {
  cacheTtl?: number;
}

interface CacheSetOptions {
  expirationTtl?: number;
}

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

interface JSONNamespace {
  get(key: string, options?: { type?: string; cacheTtl?: number }): Promise<any>;
  put(key: string, value: string, options?: CacheSetOptions): Promise<void>;
}

export class KVJSONStore {
  namespace: JSONNamespace | null;
  prefix: string;
  traceCtx: ExecutionContext | undefined;

  constructor(namespace: JSONNamespace | null, prefix: string, traceCtx?: ExecutionContext) {
    this.namespace = namespace;
    this.prefix = String(prefix || "").replace(/^:+|:+$/g, "");
    this.traceCtx = traceCtx;
  }

  async get<T = any>(key: string, options: CacheGetOptions = {}): Promise<{ found: boolean; value: T | null }> {
    if (!this.namespace) return { found: false, value: null };
    return enterSpan(this.traceCtx, "cache.get", { "cache.key": key, "cache.prefix": this.prefix }, async (span) => {
      const value = await this.namespace.get(this.fullKey(key), {
        type: "json",
        cacheTtl: options.cacheTtl,
      });
      const found = value !== null && value !== undefined;
      span.setAttribute("cache.hit", found);
      return { found, value: value as T };
    });
  }

  async set(key: string, value: unknown, options: CacheSetOptions = {}): Promise<void> {
    if (!this.namespace) return;
    await enterSpan(this.traceCtx, "cache.put", { "cache.key": key, "cache.prefix": this.prefix }, async (span) => {
      const putOptions: KVNamespacePutOptions = {};
      if (options.expirationTtl) {
        putOptions.expirationTtl = Math.max(60, Math.ceil(options.expirationTtl));
        span.setAttribute("cache.expiration_ttl", putOptions.expirationTtl);
      }
      await this.namespace.put(this.fullKey(key), JSON.stringify(value), putOptions);
    });
  }

  fullKey(key: string): string {
    const cleaned = String(key || "").trim();
    return this.prefix ? `${this.prefix}:${cleaned}` : cleaned;
  }
}

export class MemoryKVNamespace {
  entries: Map<string, MemoryEntry>;

  constructor() {
    this.entries = new Map();
  }

  async get(key: string, options: { type?: "json" } = {}): Promise<any> {
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

  async put(key: string, value: string, options: CacheSetOptions = {}): Promise<void> {
    const entry = { value: String(value), expiresAt: 0 };
    if (options.expirationTtl) {
      entry.expiresAt = Date.now() + options.expirationTtl * 1000;
    }
    this.entries.set(key, entry);
  }
}
