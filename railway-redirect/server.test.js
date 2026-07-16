import { afterEach, describe, expect, it } from "vitest";

import { createRedirectServer, redirectLocation } from "./server.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("redirectLocation", () => {
  it("preserves paths and query strings", () => {
    expect(redirectLocation("/api/outages?geocode=0")).toBe(
      "https://enedis.stanislas.cloud/api/outages?geocode=0",
    );
  });

  it("does not let a protocol-relative request change the target host", () => {
    expect(redirectLocation("//example.com/phish")).toBe("https://enedis.stanislas.cloud//example.com/phish");
  });
});

describe("redirect server", () => {
  it("serves a local healthcheck and redirects every other path", async () => {
    const server = createRedirectServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok\n");

    const redirect = await fetch(`http://127.0.0.1:${port}/map?zoom=12`, { redirect: "manual" });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("https://enedis.stanislas.cloud/map?zoom=12");
    expect(redirect.headers.get("cache-control")).toBe("no-store");
  });
});
