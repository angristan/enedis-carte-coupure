import { Schema } from "effect";
import type { WorkerEnv } from "./config.js";

export interface CoordinatedRequest {
  readonly provider: string;
  readonly key: string;
  readonly operation: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type CoordinatedResult = {
  readonly ok: true;
  readonly status: number;
  readonly statusText: string;
  readonly text: string;
} | {
  readonly ok: false;
  readonly reason: "budget" | "concurrency" | "timeout" | "transport" | "body";
  readonly retryAfter: number;
  readonly message: string;
};

export const CoordinatedResultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    status: Schema.Number,
    statusText: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals([
      "budget",
      "concurrency",
      "timeout",
      "transport",
      "body",
    ]),
    retryAfter: Schema.Number,
    message: Schema.String,
  }),
]);

const CoordinatedRequestSchema = Schema.Struct({
  provider: Schema.String,
  key: Schema.String,
  operation: Schema.String,
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optionalKey(Schema.String),
});

interface ProviderPolicy {
  readonly tokensPerSecond: number;
  readonly burst: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
  readonly origins: ReadonlyArray<string>;
  readonly methods: ReadonlyArray<string>;
}

interface BucketRow extends Record<string, SqlStorageValue> {
  readonly tokens: number;
  readonly updated_at: number;
}

interface RecentResult {
  readonly expiresAt: number;
  readonly bodyBytes: number;
  readonly result: CoordinatedResult & { readonly ok: true };
}

interface Permit {
  readonly ok: true;
  readonly release: () => void;
}

type CoordinatedFailure = CoordinatedResult & { readonly ok: false };

interface PermitWaiter {
  readonly policy: ProviderPolicy;
  readonly expiresAt: number;
  readonly resolve: (result: Permit | CoordinatedFailure) => void;
  readonly reject: (error: unknown) => void;
}

interface ProviderQueue {
  active: number;
  readonly waiting: Array<PermitWaiter>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface SchedulerOptions {
  readonly maximumQueueLength: number;
  readonly maximumWaitMs: number;
  readonly now: () => number;
  readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const RECENT_TTL_MS = 10_000;
const RECENT_MAXIMUM_ENTRIES = 128;
const RECENT_MAXIMUM_BODY_BYTES = 16 * 1024 * 1024;
const MAXIMUM_KEY_LENGTH = 64 * 1024;
const MAXIMUM_QUEUE_LENGTH = 64;
const MAXIMUM_QUEUE_WAIT_MS = 15_000;

const POLICIES: Readonly<Record<string, ProviderPolicy>> = {
  Enedis: {
    tokensPerSecond: 1,
    burst: 12,
    concurrency: 6,
    timeoutMs: 5_000,
    maximumBytes: 2 * 1024 * 1024,
    origins: ["https://www.enedis.fr"],
    methods: ["GET"],
  },
  communes: {
    tokensPerSecond: 0.5,
    burst: 4,
    concurrency: 2,
    timeoutMs: 5_000,
    maximumBytes: 5 * 1024 * 1024,
    origins: ["https://apicarto.ign.fr"],
    methods: ["GET"],
  },
  geocoder: {
    tokensPerSecond: 2,
    burst: 8,
    concurrency: 4,
    timeoutMs: 3_000,
    maximumBytes: 256 * 1024,
    origins: ["https://data.geopf.fr", "https://api-adresse.data.gouv.fr"],
    methods: ["GET"],
  },
  Overpass: {
    tokensPerSecond: 0.1,
    burst: 6,
    concurrency: 2,
    timeoutMs: 7_000,
    maximumBytes: 8 * 1024 * 1024,
    origins: [
      "https://maps.mail.ru",
      "https://lz4.overpass-api.de",
    ],
    methods: ["POST"],
  },
  Turnstile: {
    tokensPerSecond: 5,
    burst: 10,
    concurrency: 5,
    timeoutMs: 5_000,
    maximumBytes: 64 * 1024,
    origins: ["https://challenges.cloudflare.com"],
    methods: ["POST"],
  },
};

class RecentSuccessCache {
  private readonly entries = new Map<string, RecentResult>();
  private bodyBytes = 0;

  constructor(
    private readonly maximumEntries = RECENT_MAXIMUM_ENTRIES,
    private readonly maximumBodyBytes = RECENT_MAXIMUM_BODY_BYTES,
    private readonly ttlMs = RECENT_TTL_MS,
  ) {}

  get entryCount(): number {
    return this.entries.size;
  }

  get approximateBodyBytes(): number {
    return this.bodyBytes;
  }

  get(
    key: string,
    now: number,
  ): (CoordinatedResult & { readonly ok: true }) | undefined {
    this.prune(now);
    return this.entries.get(key)?.result;
  }

  set(
    key: string,
    result: CoordinatedResult & { readonly ok: true },
    now: number,
  ): void {
    this.prune(now);
    this.delete(key);

    const bodyBytes = result.text.length * 2;
    if (
      this.maximumEntries <= 0 ||
      bodyBytes > this.maximumBodyBytes
    ) {
      return;
    }

    while (
      this.entries.size >= this.maximumEntries ||
      this.bodyBytes + bodyBytes > this.maximumBodyBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }

    this.entries.set(key, {
      expiresAt: now + this.ttlMs,
      bodyBytes,
      result,
    });
    this.bodyBytes += bodyBytes;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }

  private delete(key: string): void {
    const existing = this.entries.get(key);
    if (existing === undefined) return;
    this.entries.delete(key);
    this.bodyBytes -= existing.bodyBytes;
  }
}

class PermitScheduler {
  private readonly queues = new Map<string, ProviderQueue>();
  private readonly options: SchedulerOptions;

  constructor(
    private readonly takeToken: (
      provider: string,
      policy: ProviderPolicy,
      now: number,
    ) => { readonly allowed: true } | {
      readonly allowed: false;
      readonly retryAfter: number;
    },
    options: Partial<SchedulerOptions> = {},
  ) {
    this.options = {
      maximumQueueLength: options.maximumQueueLength ?? MAXIMUM_QUEUE_LENGTH,
      maximumWaitMs: options.maximumWaitMs ?? MAXIMUM_QUEUE_WAIT_MS,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? setTimeout,
      clearTimer: options.clearTimer ?? clearTimeout,
    };
  }

  acquire(
    provider: string,
    policy: ProviderPolicy,
  ): Promise<Permit | CoordinatedFailure> {
    const queue = this.queueFor(provider);
    if (queue.waiting.length >= this.options.maximumQueueLength) {
      return Promise.resolve(concurrencyFailure("upstream request queue is full"));
    }

    return new Promise((resolve, reject) => {
      queue.waiting.push({
        policy,
        expiresAt: this.options.now() + this.options.maximumWaitMs,
        resolve,
        reject,
      });
      this.pump(provider, queue);
    });
  }

  private pump(provider: string, queue: ProviderQueue): void {
    this.clearScheduledPump(queue);

    while (queue.waiting.length > 0) {
      const waiter = queue.waiting[0];
      const now = this.options.now();

      if (queue.active >= waiter.policy.concurrency) {
        if (now >= waiter.expiresAt) {
          queue.waiting.shift();
          waiter.resolve(concurrencyFailure("upstream concurrency wait expired"));
          continue;
        }
        this.schedulePump(provider, queue, waiter.expiresAt - now);
        return;
      }

      let budget: { readonly allowed: true } | {
        readonly allowed: false;
        readonly retryAfter: number;
      };
      try {
        budget = this.takeToken(provider, waiter.policy, now);
      } catch (error) {
        queue.waiting.shift();
        waiter.reject(error);
        continue;
      }

      if (!budget.allowed) {
        if (now >= waiter.expiresAt) {
          queue.waiting.shift();
          waiter.resolve(budgetFailure(budget.retryAfter));
          continue;
        }
        this.schedulePump(
          provider,
          queue,
          Math.min(budget.retryAfter * 1000, waiter.expiresAt - now),
        );
        return;
      }

      queue.waiting.shift();
      queue.active += 1;
      let released = false;
      waiter.resolve({
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          queue.active -= 1;
          this.pump(provider, queue);
          this.deleteIdleQueue(provider, queue);
        },
      });
    }

    this.deleteIdleQueue(provider, queue);
  }

  private queueFor(provider: string): ProviderQueue {
    const existing = this.queues.get(provider);
    if (existing !== undefined) return existing;
    const queue: ProviderQueue = { active: 0, waiting: [], timer: undefined };
    this.queues.set(provider, queue);
    return queue;
  }

  private schedulePump(
    provider: string,
    queue: ProviderQueue,
    delayMs: number,
  ): void {
    queue.timer = this.options.setTimer(() => {
      queue.timer = undefined;
      this.pump(provider, queue);
    }, Math.max(0, delayMs));
  }

  private clearScheduledPump(queue: ProviderQueue): void {
    if (queue.timer === undefined) return;
    this.options.clearTimer(queue.timer);
    queue.timer = undefined;
  }

  private deleteIdleQueue(provider: string, queue: ProviderQueue): void {
    if (queue.active === 0 && queue.waiting.length === 0) {
      this.clearScheduledPump(queue);
      if (this.queues.get(provider) === queue) this.queues.delete(provider);
    }
  }
}

export class UpstreamCoordinator {
  private readonly inFlight = new Map<string, Promise<CoordinatedResult>>();
  private readonly recent = new RecentSuccessCache();
  private readonly scheduler: PermitScheduler;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: WorkerEnv,
  ) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS budget (provider TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.scheduler = new PermitScheduler((provider, policy, now) =>
      this.takeToken(provider, policy, now)
    );
  }

  fetch(request: Request): Promise<Response> {
    return handleCoordinatorFetch(request, (input) => this.request(input));
  }

  request(input: CoordinatedRequest): Promise<CoordinatedResult> {
    const policy = policyFor(input);
    if (policy === undefined) {
      return Promise.resolve({
        ok: false,
        reason: "transport",
        retryAfter: 1,
        message: "upstream request is not allowed",
      });
    }

    const recent = this.recent.get(input.key, Date.now());
    if (recent !== undefined) return Promise.resolve(recent);

    const existing = this.inFlight.get(input.key);
    if (existing !== undefined) return existing;

    const pending = this.execute(input, policy);
    this.inFlight.set(input.key, pending);
    const clearPending = () => {
      if (this.inFlight.get(input.key) === pending) this.inFlight.delete(input.key);
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private async execute(
    input: CoordinatedRequest,
    policy: ProviderPolicy,
  ): Promise<CoordinatedResult> {
    const permit = await this.scheduler.acquire(input.provider, policy);
    if (!permit.ok) return permit;

    try {
      const result = await fetchWithLimits(input, policy);
      if (result.ok && result.status >= 200 && result.status < 300) {
        this.recent.set(input.key, result, Date.now());
      }
      return result;
    } finally {
      permit.release();
    }
  }

  private takeToken(
    provider: string,
    policy: ProviderPolicy,
    now: number,
  ): { readonly allowed: true } | {
    readonly allowed: false;
    readonly retryAfter: number;
  } {
    const row = this.ctx.storage.sql.exec<BucketRow>(
      "SELECT tokens, updated_at FROM budget WHERE provider = ?",
      provider,
    ).toArray()[0];
    const previousTokens = typeof row?.tokens === "number"
      ? row.tokens
      : policy.burst;
    const previousUpdate = typeof row?.updated_at === "number"
      ? row.updated_at
      : now;
    const budget = consumeToken({
      tokens: previousTokens,
      updatedAt: previousUpdate,
      now,
      tokensPerSecond: policy.tokensPerSecond,
      burst: policy.burst,
    });
    this.ctx.storage.sql.exec(
      "INSERT INTO budget (provider, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at",
      provider,
      budget.tokens,
      now,
    );
    return budget.allowed
      ? { allowed: true }
      : { allowed: false, retryAfter: budget.retryAfter };
  }
}

export function consumeToken(input: {
  readonly tokens: number;
  readonly updatedAt: number;
  readonly now: number;
  readonly tokensPerSecond: number;
  readonly burst: number;
}): { readonly allowed: true; readonly tokens: number } | {
  readonly allowed: false;
  readonly tokens: number;
  readonly retryAfter: number;
} {
  const elapsed = Math.max(0, input.now - input.updatedAt);
  const available = Math.min(
    input.burst,
    input.tokens + elapsed * input.tokensPerSecond / 1000,
  );
  if (available >= 1) return { allowed: true, tokens: available - 1 };
  return {
    allowed: false,
    tokens: available,
    retryAfter: Math.max(
      1,
      Math.ceil((1 - available) / input.tokensPerSecond),
    ),
  };
}

function policyFor(input: CoordinatedRequest): ProviderPolicy | undefined {
  const policy = POLICIES[input.provider];
  if (
    policy === undefined ||
    input.key.length === 0 ||
    input.key.length > MAXIMUM_KEY_LENGTH
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return undefined;
  }

  const method = input.method.toUpperCase();
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !policy.origins.includes(url.origin) ||
    !policy.methods.includes(method)
  ) {
    return undefined;
  }

  return policy;
}

async function handleCoordinatorFetch(
  request: Request,
  execute: (input: CoordinatedRequest) => Promise<CoordinatedResult>,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let input: CoordinatedRequest;
  try {
    const body: unknown = await request.json();
    input = Schema.decodeUnknownSync(CoordinatedRequestSchema)(body);
  } catch {
    return Response.json(
      { error: "invalid coordinator request" },
      { status: 400 },
    );
  }

  try {
    return Response.json(await execute(input));
  } catch {
    return Response.json(
      { error: "coordinator execution failed" },
      { status: 500 },
    );
  }
}

async function fetchWithLimits(
  input: CoordinatedRequest,
  policy: ProviderPolicy,
): Promise<CoordinatedResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: input.method.toUpperCase(),
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readLimitedBody(
      response.body,
      policy.maximumBytes,
      controller,
    );
    if (text === undefined) {
      return {
        ok: false,
        reason: "body",
        retryAfter: 1,
        message: "upstream response exceeded size limit",
      };
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      text,
    };
  } catch (error) {
    return controller.signal.aborted
      ? {
        ok: false,
        reason: "timeout",
        retryAfter: 1,
        message: `upstream request exceeded ${policy.timeoutMs}ms`,
      }
      : {
        ok: false,
        reason: "transport",
        retryAfter: 1,
        message: error instanceof Error ? error.message : "upstream fetch failed",
      };
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  controller: AbortController,
): Promise<string | undefined> {
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return output + decoder.decode();
    size += chunk.value.byteLength;
    if (size > maximumBytes) {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // The size violation remains authoritative if cancellation also fails.
      }
      return undefined;
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
}

function concurrencyFailure(message: string): CoordinatedFailure {
  return {
    ok: false,
    reason: "concurrency",
    retryAfter: 1,
    message,
  };
}

function budgetFailure(retryAfter: number): CoordinatedFailure {
  return {
    ok: false,
    reason: "budget",
    retryAfter,
    message: "upstream request budget exhausted",
  };
}

export const testExports = {
  POLICIES,
  MAXIMUM_KEY_LENGTH,
  RecentSuccessCache,
  PermitScheduler,
  policyFor,
  handleCoordinatorFetch,
  readLimitedBody,
};
