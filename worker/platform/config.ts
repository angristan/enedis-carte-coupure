import { Context, Effect, Layer, Schema } from "effect";

export type WorkerEnv = Partial<Env>;

export class WorkerConfig extends Context.Service<WorkerConfig, {
  readonly cachePrefix: string;
  readonly outageCacheTtl: number;
  readonly outageStaleTtl: number;
  readonly communesCacheTtl: number;
  readonly production: boolean;
  readonly appOrigin: string;
  readonly turnstileSiteKey: string;
  readonly turnstileSecretKey: string;
  readonly turnstileHostname: string;
  readonly sessionSigningSecret: string;
  readonly cursorSigningSecret: string;
  readonly sessionTtl: number;
  readonly cursorTtl: number;
}>()("WorkerConfig") {}

const EnvironmentSchema = Schema.Struct({
  CACHE_PREFIX: Schema.optionalKey(Schema.String),
  OUTAGE_CACHE_TTL: Schema.optionalKey(Schema.String),
  OUTAGE_CACHE_STALE_TTL: Schema.optionalKey(Schema.String),
  COMMUNES_CACHE_TTL: Schema.optionalKey(Schema.String),
  APP_ENV: Schema.optionalKey(Schema.String),
  APP_ORIGIN: Schema.optionalKey(Schema.String),
  TURNSTILE_SITE_KEY: Schema.optionalKey(Schema.String),
  TURNSTILE_SECRET_KEY: Schema.optionalKey(Schema.String),
  TURNSTILE_HOSTNAME: Schema.optionalKey(Schema.String),
  SESSION_SIGNING_SECRET: Schema.optionalKey(Schema.String),
  CURSOR_SIGNING_SECRET: Schema.optionalKey(Schema.String),
  SESSION_TTL: Schema.optionalKey(Schema.String),
  CURSOR_TTL: Schema.optionalKey(Schema.String),
});

export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_KEY =
  "1x0000000000000000000000000000000AA";
const LOCAL_SIGNING_SECRET = "local-development-signing-secret-only";

export const loadWorkerConfig = Effect.fn("WorkerConfig.load")(
  function* (environment: unknown) {
    const decoded = yield* Schema.decodeUnknownEffect(EnvironmentSchema)(
      environment,
    ).pipe(Effect.orDie);
    const production = decoded.APP_ENV === "production";
    const appOrigin = decoded.APP_ORIGIN ?? "http://127.0.0.1:5173";
    const turnstileHostname = decoded.TURNSTILE_HOSTNAME ?? "";
    const turnstileSecretKey = decoded.TURNSTILE_SECRET_KEY ??
      (production ? "" : TURNSTILE_TEST_SECRET_KEY);
    const sessionSigningSecret = decoded.SESSION_SIGNING_SECRET ??
      (production ? "" : LOCAL_SIGNING_SECRET);
    const cursorSigningSecret = decoded.CURSOR_SIGNING_SECRET ??
      (production ? "" : `${LOCAL_SIGNING_SECRET}:cursor`);

    if (
      production &&
      ((decoded.TURNSTILE_SITE_KEY ?? "").length === 0 ||
        turnstileSecretKey.length === 0 ||
        turnstileHostname.length === 0 ||
        !isSecureOrigin(appOrigin) ||
        sessionSigningSecret.length < 32 ||
        cursorSigningSecret.length < 32)
    ) {
      return yield* Effect.die(
        new Error(
          "production origin, Turnstile configuration, and signing secrets are required",
        ),
      );
    }

    const outageCacheTtl = parseDuration(
      decoded.OUTAGE_CACHE_TTL,
      15 * 60,
    );

    return {
      cachePrefix: decoded.CACHE_PREFIX ?? "enedis-carte-coupure",
      outageCacheTtl,
      outageStaleTtl: parseDuration(
        decoded.OUTAGE_CACHE_STALE_TTL,
        7 * 24 * 60 * 60,
      ),
      communesCacheTtl: parseDuration(
        decoded.COMMUNES_CACHE_TTL,
        7 * 24 * 60 * 60,
      ),
      production,
      appOrigin,
      turnstileSiteKey: decoded.TURNSTILE_SITE_KEY ??
        TURNSTILE_TEST_SITE_KEY,
      turnstileSecretKey,
      turnstileHostname,
      sessionSigningSecret,
      cursorSigningSecret,
      sessionTtl: parseDuration(decoded.SESSION_TTL, 30 * 60),
      cursorTtl: parseDuration(decoded.CURSOR_TTL, 10 * 60),
    };
  },
);

export function configLayer(env: WorkerEnv) {
  return Layer.effect(WorkerConfig)(loadWorkerConfig(env));
}

export function parseDuration(
  value: string | undefined,
  fallbackSeconds: number,
): number {
  if (value === undefined) return fallbackSeconds;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) return fallbackSeconds;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  if (!Number.isFinite(amount) || amount < 0) return fallbackSeconds;
  if (unit === "ms") return amount / 1000;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 3600;
  if (unit === "d") return amount * 86400;
  return amount;
}

function isSecureOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}
