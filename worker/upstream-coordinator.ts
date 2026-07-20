import { Schema } from "effect";
import type { WorkerEnv } from "./platform.js";

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
}

interface BucketRow extends Record<string, SqlStorageValue> {
  readonly tokens: number;
  readonly updated_at: number;
}

interface RecentResult {
  readonly expiresAt: number;
  readonly result: CoordinatedResult & { readonly ok: true };
}

const RECENT_TTL_MS = 10_000;

const POLICIES: Readonly<Record<string, ProviderPolicy>> = {
  Enedis: {
    tokensPerSecond: 1,
    burst: 12,
    concurrency: 6,
    timeoutMs: 5_000,
    maximumBytes: 2 * 1024 * 1024,
  },
  communes: {
    tokensPerSecond: 0.5,
    burst: 4,
    concurrency: 2,
    timeoutMs: 5_000,
    maximumBytes: 5 * 1024 * 1024,
  },
  geocoder: {
    tokensPerSecond: 2,
    burst: 8,
    concurrency: 4,
    timeoutMs: 3_000,
    maximumBytes: 256 * 1024,
  },
  Overpass: {
    tokensPerSecond: 0.1,
    burst: 2,
    concurrency: 2,
    timeoutMs: 7_000,
    maximumBytes: 8 * 1024 * 1024,
  },
  Turnstile: {
    tokensPerSecond: 5,
    burst: 10,
    concurrency: 5,
    timeoutMs: 5_000,
    maximumBytes: 64 * 1024,
  },
};

export class UpstreamCoordinator {
  private readonly inFlight = new Map<string, Promise<CoordinatedResult>>();
  private readonly recent = new Map<string, RecentResult>();
  private active = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: WorkerEnv,
  ) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS budget (provider TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    try {
      const input = Schema.decodeUnknownSync(CoordinatedRequestSchema)(
        await request.json(),
      );
      const result = await this.request(input);
      return Response.json(result);
    } catch {
      return Response.json({ error: "invalid coordinator request" }, { status: 400 });
    }
  }

  request(input: CoordinatedRequest): Promise<CoordinatedResult> {
    const policy = POLICIES[input.provider];
    if (policy === undefined || input.key.length === 0 || input.key.length > 1024) {
      return Promise.resolve({
        ok: false,
        reason: "transport",
        retryAfter: 1,
        message: "upstream request is not allowed",
      });
    }

    const now = Date.now();
    const recent = this.recent.get(input.key);
    if (recent !== undefined && recent.expiresAt > now) {
      return Promise.resolve(recent.result);
    }
    if (recent !== undefined) this.recent.delete(input.key);

    const existing = this.inFlight.get(input.key);
    if (existing !== undefined) return existing;

    const pending = this.execute(input, policy);
    this.inFlight.set(input.key, pending);
    void pending.finally(() => {
      if (this.inFlight.get(input.key) === pending) this.inFlight.delete(input.key);
    });
    return pending;
  }

  private async execute(
    input: CoordinatedRequest,
    policy: ProviderPolicy,
  ): Promise<CoordinatedResult> {
    if (this.active >= policy.concurrency) {
      return {
        ok: false,
        reason: "concurrency",
        retryAfter: 1,
        message: "upstream concurrency budget exhausted",
      };
    }

    const budget = this.takeToken(input.provider, policy, Date.now());
    if (!budget.allowed) {
      return {
        ok: false,
        reason: "budget",
        retryAfter: budget.retryAfter,
        message: "upstream request budget exhausted",
      };
    }

    this.active += 1;
    try {
      const result = await fetchWithLimits(input, policy);
      if (result.ok && result.status >= 200 && result.status < 300) {
        this.recent.set(input.key, {
          expiresAt: Date.now() + RECENT_TTL_MS,
          result,
        });
      }
      return result;
    } finally {
      this.active -= 1;
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

async function fetchWithLimits(
  input: CoordinatedRequest,
  policy: ProviderPolicy,
): Promise<CoordinatedResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
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
      await reader.cancel();
      return undefined;
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
}

export const testExports = { POLICIES };
