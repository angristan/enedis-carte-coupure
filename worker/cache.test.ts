import { describe, expect, it } from "vitest";
import { KVJSONStore, MemoryKVNamespace } from "./cache.js";
import { DEFAULT_QUERY, EnedisClient } from "./enedis.js";
import { testExports } from "./index.js";
import { parseDuration } from "./util.js";

describe("KV cache helpers", () => {
  it("round-trips JSON through a prefixed KV namespace", async () => {
    const store = new KVJSONStore(new MemoryKVNamespace(), "enedis-test");
    await store.set("outages:abc", { ok: true }, { expirationTtl: 60 });
    await expect(store.get("outages:abc")).resolves.toEqual({ found: true, value: { ok: true } });
  });

  it("uses deterministic outage cache keys", async () => {
    const query = { insee: "75056", city: "Paris" };
    await expect(testExports.outageCacheKey(query, false, true)).resolves.toBe(
      await testExports.outageCacheKey(query, false, true),
    );
    await expect(testExports.outageCacheKey(query, true, true)).resolves.not.toBe(
      await testExports.outageCacheKey(query, false, true),
    );
  });

  it("parses day durations for longer-lived KV indexes", () => {
    expect(parseDuration("7d", 1)).toBe(604800);
  });

  it("reuses Enedis payloads from one KV index", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify({ ok: true, fetches }), { status: 200 });
    };

    try {
      const store = new KVJSONStore(new MemoryKVNamespace(), "enedis-test");
      const firstClient = new EnedisClient(store, {}, 300);
      const first = await firstClient.fetch(DEFAULT_QUERY);
      await firstClient.save();

      const secondClient = new EnedisClient(store, {}, 300);
      const second = await secondClient.fetch(DEFAULT_QUERY);

      expect(fetches).toBe(1);
      expect(second).toEqual(first);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("can bypass the raw Enedis KV index for composed viewport requests", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify({ ok: true, fetches }), { status: 200 });
    };

    try {
      const store = new KVJSONStore(new MemoryKVNamespace(), "enedis-test");
      const firstClient = new EnedisClient(store, {}, 300);
      await firstClient.fetch(DEFAULT_QUERY, { cache: false });
      await firstClient.save();

      const secondClient = new EnedisClient(store, {}, 300);
      await secondClient.fetch(DEFAULT_QUERY, { cache: false });

      await expect(store.get("enedis:index")).resolves.toEqual({ found: false, value: null });
      expect(fetches).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
