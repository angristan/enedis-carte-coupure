import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import {
  type CoordinatedRequest,
  type CoordinatedResult,
  consumeToken,
  testExports,
} from "./upstream-coordinator.js";

const successfulResult = (
  text: string,
): CoordinatedResult & { readonly ok: true } => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text,
});

const coordinatedRequest = (
  overrides: Partial<CoordinatedRequest> = {},
): CoordinatedRequest => ({
  provider: "Enedis",
  key: "commune:75056",
  operation: "enedis.fetch",
  url: "https://www.enedis.fr/panne-interruption-ajax",
  method: "GET",
  headers: {},
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

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

  it("returns the token refill delay when exhausted", () => {
    assert.deepEqual(consumeToken({
      tokens: 0,
      updatedAt: 1_000,
      now: 1_000,
      tokensPerSecond: 0.1,
      burst: 6,
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

describe("recent success cache", () => {
  it("evicts the oldest entry deterministically by count", () => {
    const cache = new testExports.RecentSuccessCache(2, 100, 10_000);
    cache.set("a", successfulResult("a"), 0);
    cache.set("b", successfulResult("b"), 1);
    assert.deepEqual(cache.get("a", 2), successfulResult("a"));

    cache.set("c", successfulResult("c"), 3);
    assert.isUndefined(cache.get("a", 3));
    assert.deepEqual(cache.get("b", 3), successfulResult("b"));
    assert.deepEqual(cache.get("c", 3), successfulResult("c"));
    assert.strictEqual(cache.entryCount, 2);
  });

  it("bounds approximate UTF-16 body memory and skips oversized entries", () => {
    const cache = new testExports.RecentSuccessCache(10, 8, 10_000);
    cache.set("a", successfulResult("aa"), 0);
    cache.set("b", successfulResult("bb"), 1);
    assert.strictEqual(cache.approximateBodyBytes, 8);

    cache.set("c", successfulResult("cc"), 2);
    assert.isUndefined(cache.get("a", 2));
    assert.strictEqual(cache.approximateBodyBytes, 8);

    cache.set("oversized", successfulResult("12345"), 3);
    assert.isUndefined(cache.get("oversized", 3));
    assert.deepEqual(cache.get("b", 3), successfulResult("bb"));
    assert.deepEqual(cache.get("c", 3), successfulResult("cc"));
    assert.strictEqual(cache.approximateBodyBytes, 8);
  });

  it("prunes all expired entries on access", () => {
    const cache = new testExports.RecentSuccessCache(10, 100, 10);
    cache.set("a", successfulResult("a"), 0);
    cache.set("b", successfulResult("b"), 1);
    cache.set("c", successfulResult("c"), 2);

    assert.isUndefined(cache.get("missing", 12));
    assert.strictEqual(cache.entryCount, 0);
    assert.strictEqual(cache.approximateBodyBytes, 0);
  });
});

describe("provider policy", () => {
  it("allows only each provider's HTTPS origins and methods", () => {
    assert.isDefined(testExports.policyFor(coordinatedRequest()));
    assert.isDefined(testExports.policyFor(coordinatedRequest({
      provider: "geocoder",
      url: "https://api-adresse.data.gouv.fr/search/",
    })));
    assert.isDefined(testExports.policyFor(coordinatedRequest({
      provider: "Overpass",
      url: "https://lz4.overpass-api.de/api/interpreter",
      method: "POST",
    })));

    assert.isUndefined(testExports.policyFor(coordinatedRequest({
      url: "http://www.enedis.fr/panne-interruption-ajax",
    })));
    assert.isUndefined(testExports.policyFor(coordinatedRequest({
      url: "https://www.enedis.fr.evil.test/panne-interruption-ajax",
    })));
    assert.isUndefined(testExports.policyFor(coordinatedRequest({
      method: "POST",
    })));
    assert.isUndefined(testExports.policyFor(coordinatedRequest({
      provider: "unknown",
    })));
  });

  it("permits realistic long dedupe keys but retains an upper bound", () => {
    assert.isDefined(testExports.policyFor(coordinatedRequest({
      key: "x".repeat(8 * 1024),
    })));
    assert.isUndefined(testExports.policyFor(coordinatedRequest({
      key: "x".repeat(testExports.MAXIMUM_KEY_LENGTH + 1),
    })));
  });

  it("configures one six-request Overpass burst", () => {
    assert.strictEqual(testExports.POLICIES.Overpass.burst, 6);
    assert.strictEqual(testExports.POLICIES.Overpass.concurrency, 2);
    assert.strictEqual(testExports.POLICIES.Overpass.tokensPerSecond, 0.1);
  });
});

describe("permit scheduler", () => {
  it("queues in FIFO order until concurrency permits are released", async () => {
    const policy = { ...testExports.POLICIES.Enedis, concurrency: 1 };
    const scheduler = new testExports.PermitScheduler(() => ({ allowed: true }));

    const first = await scheduler.acquire("Enedis", policy);
    const order: Array<string> = [];
    const secondPromise = scheduler.acquire("Enedis", policy).then((permit) => {
      order.push("second");
      return permit;
    });
    const thirdPromise = scheduler.acquire("Enedis", policy).then((permit) => {
      order.push("third");
      return permit;
    });
    await Promise.resolve();
    assert.deepEqual(order, []);

    assert.isTrue("release" in first);
    if (!("release" in first)) return;
    first.release();
    const second = await secondPromise;
    assert.deepEqual(order, ["second"]);

    assert.isTrue("release" in second);
    if (!("release" in second)) return;
    second.release();
    const third = await thirdPromise;
    assert.deepEqual(order, ["second", "third"]);

    assert.isTrue("release" in third);
    if ("release" in third) third.release();
  });

  it("caps the queue and expires a concurrency wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const policy = { ...testExports.POLICIES.Enedis, concurrency: 1 };
    const scheduler = new testExports.PermitScheduler(
      () => ({ allowed: true }),
      { maximumQueueLength: 1, maximumWaitMs: 1_000 },
    );

    const first = await scheduler.acquire("Enedis", policy);
    const waiting = scheduler.acquire("Enedis", policy);
    const overflow = await scheduler.acquire("Enedis", policy);
    assert.isFalse(overflow.ok);
    if (!overflow.ok) assert.strictEqual(overflow.reason, "concurrency");

    await vi.advanceTimersByTimeAsync(1_000);
    const expired = await waiting;
    assert.isFalse(expired.ok);
    if (!expired.ok) assert.strictEqual(expired.reason, "concurrency");

    assert.isTrue("release" in first);
    if ("release" in first) first.release();
  });

  it("waits for a token and fails closed when the budget wait expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const policy = testExports.POLICIES.Overpass;
    const refillScheduler = new testExports.PermitScheduler(() => {
      if (Date.now() >= 1_000) return { allowed: true };
      return { allowed: false, retryAfter: 1 };
    }, { maximumWaitMs: 2_000 });

    let resolved = false;
    const permitPromise = refillScheduler.acquire("Overpass", policy).then(
      (permit) => {
        resolved = true;
        return permit;
      },
    );
    await vi.advanceTimersByTimeAsync(999);
    assert.isFalse(resolved);
    await vi.advanceTimersByTimeAsync(1);
    const permit = await permitPromise;
    assert.isTrue("release" in permit);
    if ("release" in permit) permit.release();

    const exhaustedScheduler = new testExports.PermitScheduler(
      () => ({ allowed: false, retryAfter: 10 }),
      { maximumWaitMs: 1_000 },
    );
    const exhaustedPromise = exhaustedScheduler.acquire("Overpass", policy);
    await vi.advanceTimersByTimeAsync(1_000);
    const exhausted = await exhaustedPromise;
    assert.isFalse(exhausted.ok);
    if (!exhausted.ok) assert.strictEqual(exhausted.reason, "budget");
  });

  it("admits six Overpass requests before waiting for the 0.1/s refill", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const policy = testExports.POLICIES.Overpass;
    let tokens = policy.burst;
    let updatedAt = 0;
    const scheduler = new testExports.PermitScheduler((_provider, _policy, now) => {
      const budget = consumeToken({
        tokens,
        updatedAt,
        now,
        tokensPerSecond: policy.tokensPerSecond,
        burst: policy.burst,
      });
      tokens = budget.tokens;
      updatedAt = now;
      return budget.allowed
        ? { allowed: true }
        : { allowed: false, retryAfter: budget.retryAfter };
    });

    const burst = Array.from(
      { length: 6 },
      () => scheduler.acquire("Overpass", policy),
    );
    for (const pending of burst) {
      const permit = await pending;
      assert.isTrue("release" in permit);
      if ("release" in permit) permit.release();
    }

    let seventhResolved = false;
    const seventhPromise = scheduler.acquire("Overpass", policy).then(
      (permit) => {
        seventhResolved = true;
        return permit;
      },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    assert.isFalse(seventhResolved);
    await vi.advanceTimersByTimeAsync(1);
    const seventh = await seventhPromise;
    assert.isTrue("release" in seventh);
    if ("release" in seventh) seventh.release();
  });
});

describe("coordinator HTTP boundary", () => {
  it("returns 400 for malformed schema input", async () => {
    let executed = false;
    const response = await testExports.handleCoordinatorFetch(
      new Request("https://coordinator.internal/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "Enedis" }),
      }),
      async () => {
        executed = true;
        return successfulResult("unused");
      },
    );

    assert.strictEqual(response.status, 400);
    assert.isFalse(executed);
  });

  it("returns 500 for unexpected execution failures", async () => {
    const response = await testExports.handleCoordinatorFetch(
      new Request("https://coordinator.internal/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(coordinatedRequest()),
      }),
      async () => {
        throw new Error("SQL unavailable");
      },
    );

    assert.strictEqual(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "coordinator execution failed",
    });
  });
});

describe("response body limits", () => {
  it("accepts the exact byte limit", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("abc"));
        stream.close();
      },
    });

    assert.strictEqual(
      await testExports.readLimitedBody(body, 3, controller),
      "abc",
    );
    assert.isFalse(controller.signal.aborted);
  });

  it("aborts and rejects a body over the byte limit", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("abcd"));
        stream.close();
      },
    });

    assert.isUndefined(
      await testExports.readLimitedBody(body, 3, controller),
    );
    assert.isTrue(controller.signal.aborted);
  });
});
