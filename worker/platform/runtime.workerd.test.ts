import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker runtime bindings", () => {
  it("round-trips values through the real KV binding", async () => {
    await env.CACHE.put("integration", JSON.stringify({ ok: true }));

    expect(await env.CACHE.get("integration", "json")).toEqual({ ok: true });
  });

  it("initializes the upstream coordinator SQLite Durable Object", async () => {
    const tables = await runInDurableObject(
      env.UPSTREAM_COORDINATOR.getByName("integration"),
      (_instance, state) =>
        state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        ).toArray(),
    );

    expect(tables.map(({ name }) => name)).toContain("budget");
  });
});
