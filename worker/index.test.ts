import { assert, describe, it } from "@effect/vitest";
import {
  AllCommunesFailed,
  InvalidViewport,
  UpstreamDecodeError,
  UpstreamStatusError,
} from "./errors.js";
import { testExports } from "./index.js";

async function responseBody(response: Response): Promise<unknown> {
  return response.json();
}

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

  it("preserves warnings when every commune fails", async () => {
    const warnings = ["Paris: Enedis unavailable"];
    const response = testExports.errorResponse(
      AllCommunesFailed.make({
        message: "all visible commune requests failed",
        warnings,
      }),
    );

    assert.strictEqual(response.status, 502);
    assert.deepEqual(await responseBody(response), {
      error: "ENEDIS_FETCH_FAILED",
      message: "all visible commune requests failed",
      warnings,
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
