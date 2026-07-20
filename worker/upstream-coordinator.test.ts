import { assert, describe, it } from "@effect/vitest";
import { consumeToken } from "./upstream-coordinator.js";

describe("upstream token bucket", () => {
  it("allows bursts and consumes one token", () => {
    assert.deepEqual(consumeToken({
      tokens: 4,
      updatedAt: 1_000,
      now: 1_000,
      tokensPerSecond: 1,
      burst: 4,
    }), { allowed: true, tokens: 3 });
  });

  it("refills over time and caps at the burst", () => {
    assert.deepEqual(consumeToken({
      tokens: 0,
      updatedAt: 1_000,
      now: 11_000,
      tokensPerSecond: 1,
      burst: 4,
    }), { allowed: true, tokens: 3 });
  });

  it("returns a bounded retry delay when exhausted", () => {
    assert.deepEqual(consumeToken({
      tokens: 0,
      updatedAt: 1_000,
      now: 1_000,
      tokensPerSecond: 0.1,
      burst: 2,
    }), { allowed: false, tokens: 0, retryAfter: 10 });
  });

  it("does not mint tokens when the clock moves backwards", () => {
    assert.deepEqual(consumeToken({
      tokens: 0,
      updatedAt: 2_000,
      now: 1_000,
      tokensPerSecond: 1,
      burst: 2,
    }), { allowed: false, tokens: 0, retryAfter: 1 });
  });
});
