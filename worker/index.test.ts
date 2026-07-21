import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { AccessControl } from "./access/session.js";
import { OutageService } from "./service.js";
import {
  InvalidViewport,
  MethodNotAllowed,
  PayloadTooLarge,
  RouteNotFound,
  VerificationFailed,
  UpstreamDecodeError,
  UpstreamStatusError,
} from "./domain/errors.js";
import { testExports } from "./index.js";

async function responseBody(response: Response): Promise<unknown> {
  return response.json();
}

const AccessTest = Layer.succeed(AccessControl)({
  status: () => Effect.succeed({ verified: false, turnstileSiteKey: "test" }),
  validateCreationRequest: () => Effect.void,
  create: () => Effect.die("unused"),
  require: () => Effect.die("unused"),
  limit: () => Effect.void,
});
const RejectedAccessTest = Layer.succeed(AccessControl)({
  status: () => Effect.succeed({ verified: false, turnstileSiteKey: "test" }),
  validateCreationRequest: () =>
    Effect.fail(VerificationFailed.make({ message: "origin rejected" })),
  create: () => Effect.die("unused"),
  require: () => Effect.die("unused"),
  limit: () => Effect.void,
});
const OutageTest = Layer.succeed(OutageService)({
  viewport: () => Effect.die("unused"),
});

async function apiResponse(
  request: Request,
  access = AccessTest,
): Promise<Response | null> {
  return Effect.runPromise(
    testExports.handleApi(request).pipe(
      Effect.provide(Layer.mergeAll(access, OutageTest)),
      Effect.catch((error) => Effect.succeed(testExports.errorResponse(error))),
    ),
  );
}

describe("outage query parameters", () => {
  it("accepts viewport cursors and rejects escape hatches", () => {
    assert.strictEqual(
      testExports.invalidOutageParameter(
        new URLSearchParams("south=1&west=2&north=3&east=4&cursor=signed"),
      ),
      undefined,
    );
    assert.strictEqual(
      testExports.invalidOutageParameter(new URLSearchParams("raw=1")),
      "unsupported parameter: raw",
    );
    assert.strictEqual(
      testExports.invalidOutageParameter(new URLSearchParams("bbox=2,48,3,49")),
      "unsupported parameter: bbox",
    );
    assert.strictEqual(
      testExports.invalidOutageParameter(
        new URLSearchParams("south=1&south=2"),
      ),
      "duplicate parameter: south",
    );
  });
});

describe("API routing", () => {
  it("rejects unsupported health methods", async () => {
    const response = await apiResponse(
      new Request("https://example.test/api/health", { method: "POST" }),
    );

    assert.instanceOf(response, Response);
    if (!(response instanceof Response)) return;
    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get("Allow"), "GET");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const response = await apiResponse(
      new Request("https://example.test/api/unknown"),
    );

    assert.instanceOf(response, Response);
    if (!(response instanceof Response)) return;
    assert.strictEqual(response.status, 404);
    assert.match(response.headers.get("Content-Type") ?? "", /application\/json/);
  });

  it("rejects invalid origins before inspecting the request body", async () => {
    const response = await apiResponse(
      new Request("https://example.test/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: "x".repeat(5000) }),
      }),
      RejectedAccessTest,
    );

    assert.instanceOf(response, Response);
    if (!(response instanceof Response)) return;
    assert.strictEqual(response.status, 403);
  });

  it("rejects oversized session bodies before verification", async () => {
    const response = await apiResponse(
      new Request("https://example.test/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: "x".repeat(5000) }),
      }),
    );

    assert.instanceOf(response, Response);
    if (!(response instanceof Response)) return;
    assert.strictEqual(response.status, 413);
  });
});

describe("worker error responses", () => {
  it("maps invalid viewports to a stable 400 response", async () => {
    const response = testExports.errorResponse(
      InvalidViewport.make({ message: "missing north" }),
    );

    assert.strictEqual(response.status, 400);
    assert.deepEqual(await responseBody(response), {
      error: "INVALID_VIEWPORT",
      message: "missing north",
    });
  });

  it("maps unknown API routes to JSON 404 responses", async () => {
    const response = testExports.errorResponse(
      RouteNotFound.make({
        path: "/api/unknown",
        message: "API route not found",
      }),
    );

    assert.strictEqual(response.status, 404);
    assert.deepEqual(await responseBody(response), {
      error: "NOT_FOUND",
      message: "API route not found",
    });
  });

  it("includes Allow on method errors", async () => {
    const response = testExports.errorResponse(
      MethodNotAllowed.make({
        method: "POST",
        allow: "GET",
        message: "method not allowed",
      }),
    );

    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get("Allow"), "GET");
  });

  it("maps oversized requests to 413", async () => {
    const response = testExports.errorResponse(
      PayloadTooLarge.make({
        maximumBytes: 4096,
        message: "request body is too large",
      }),
    );

    assert.strictEqual(response.status, 413);
    assert.deepEqual(await responseBody(response), {
      error: "PAYLOAD_TOO_LARGE",
      message: "request body is too large",
    });
  });

  it("does not expose schema diagnostics from upstream payloads", async () => {
    const response = testExports.errorResponse(
      UpstreamDecodeError.make({
        provider: "Enedis",
        message: "invalid response payload",
      }),
    );

    assert.strictEqual(response.status, 502);
    assert.deepEqual(await responseBody(response), {
      error: "UPSTREAM_DECODE_ERROR",
      message: "Enedis returned an invalid response",
    });
  });

  it("does not expose upstream response bodies", async () => {
    const response = testExports.errorResponse(
      UpstreamStatusError.make({
        provider: "Enedis",
        status: 503,
        message: "Enedis returned 503: private upstream body",
      }),
    );

    assert.strictEqual(response.status, 502);
    assert.deepEqual(await responseBody(response), {
      error: "UPSTREAM_STATUS_ERROR",
      message: "Enedis returned HTTP 503",
    });
  });
});
