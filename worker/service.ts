import { Clock, Context, Effect, Layer } from "effect";
import {
  AllCommunesFailed,
  errorMessage,
  type RequestError,
  type UpstreamError,
} from "./errors.js";
import {
  boundsForCommune,
  CommuneDirectory,
  enedisQueryForCommune,
} from "./communes.js";
import { Enedis } from "./enedis.js";
import type { Bounds } from "./geo.js";
import {
  type Commune,
  CommuneOutageCacheSchema,
  type EnedisQuery,
  OutageCacheSchema,
  type OutageResponse,
} from "./models.js";
import {
  mergeOutageResponses,
  Normalizer,
  responseCommunes,
} from "./outages.js";
import { BackgroundTasks, KVStore, WorkerConfig } from "./platform.js";
import { type CryptoError, sha256Hex } from "./util.js";

export interface OutageResult {
  readonly response: OutageResponse;
  readonly cache: "HIT" | "STALE" | "MISS";
  readonly refreshedAt?: string;
  readonly freshUntil?: string;
  readonly communeStats?: {
    readonly hits: number;
    readonly stale: number;
    readonly misses: number;
  };
}

type Result = OutageResult;
type ServiceError = RequestError | CryptoError;

type CommuneResult = {
  readonly ok: true;
  readonly response: OutageResponse;
  readonly cache: "HIT" | "STALE" | "MISS";
} | { readonly ok: false; readonly warning: string };

export class OutageService extends Context.Service<OutageService, {
  readonly single: (
    query: EnedisQuery,
    includeRaw: boolean,
    geocode: boolean,
  ) => Effect.Effect<OutageResult, ServiceError>;
  readonly viewport: (
    bounds: Bounds,
    includeRaw: boolean,
    geocode: boolean,
    communeLimit?: number,
  ) => Effect.Effect<OutageResult, ServiceError>;
}>()("OutageService") {}

export const OutageServiceLive = Layer.effect(OutageService)(
  Effect.gen(function* () {
    const config = yield* WorkerConfig;
    const cache = yield* KVStore;
    const enedis = yield* Enedis;
    const communes = yield* CommuneDirectory;
    const normalizer = yield* Normalizer;
    const background = yield* BackgroundTasks;

    const store = Effect.fn("OutageService.store")(
      function* (key: string, response: OutageResponse) {
        if (config.outageCacheTtl <= 0) return;
        const now = yield* Clock.currentTimeMillis;
        yield* cache.set(key, {
          version: 5,
          refreshedAt: new Date(now).toISOString(),
          freshUntil: new Date(now + config.outageCacheTtl * 1000)
            .toISOString(),
          response,
        }, Math.max(config.outageCacheTtl, config.outageStaleTtl)).pipe(
          Effect.catchTag("CacheError", () => Effect.void),
        );
      },
    );

    const freshSingle = Effect.fn("OutageService.freshSingle")(
      function* (query: EnedisQuery, includeRaw: boolean, geocode: boolean) {
        const raw = yield* enedis.fetch(query);
        const normalized = yield* normalizer.normalize(raw, query, geocode);
        return includeRaw ? { ...normalized, raw } : normalized;
      },
    );

    const single = Effect.fn("OutageService.single")(
      function* (query: EnedisQuery, includeRaw: boolean, geocode: boolean) {
        const key = `outages:${yield* sha256Hex(
          JSON.stringify({ query, includeRaw, geocode }),
        )}`;
        const refresh = freshSingle(query, includeRaw, geocode);
        if (config.outageCacheTtl > 0) {
          const entry = yield* cache.get(key, OutageCacheSchema, 60).pipe(
            Effect.catchTag("CacheError", () => Effect.succeed(null)),
          );
          if (entry !== null) {
            const now = yield* Clock.currentTimeMillis;
            if (now < Date.parse(entry.freshUntil)) {
              return {
                response: entry.response,
                cache: "HIT",
                refreshedAt: entry.refreshedAt,
                freshUntil: entry.freshUntil,
              } satisfies Result;
            }
            yield* background.schedule(refresh.pipe(
              Effect.flatMap((response) => store(key, response)),
              Effect.catch(() => Effect.void),
            ));
            return {
              response: entry.response,
              cache: "STALE",
              refreshedAt: entry.refreshedAt,
              freshUntil: entry.freshUntil,
            } satisfies Result;
          }
        }
        const response = yield* refresh;
        yield* store(key, response);
        return { response, cache: "MISS" } satisfies Result;
      },
    );

    const refreshCommune = Effect.fn("OutageService.refreshCommune")(
      function* (
        key: string,
        commune: Commune,
        geocode: boolean,
        fallbackBounds: Bounds,
      ) {
        const query = enedisQueryForCommune(commune);
        const raw = yield* enedis.fetch(query);
        let response = yield* normalizer.normalizeSet([{ raw, query }], {
          geocode,
          geometry: false,
        });
        const geometryBounds = boundsForCommune(commune, fallbackBounds);
        if (geocode && geometryBounds !== undefined) {
          response = yield* normalizer.attachGeometry(response, geometryBounds);
        }
        const publicCommune = responseCommunes([commune])[0];
        if (publicCommune !== undefined) {
          response = { ...response, commune: publicCommune };
        }
        if (config.outageCacheTtl > 0) {
          const now = yield* Clock.currentTimeMillis;
          yield* cache.set(key, {
            version: 3,
            refreshedAt: new Date(now).toISOString(),
            freshUntil: new Date(now + config.outageCacheTtl * 1000)
              .toISOString(),
            response,
          }, Math.max(config.outageCacheTtl, config.outageStaleTtl)).pipe(
            Effect.catchTag("CacheError", () => Effect.void),
          );
        }
        return response;
      },
    );

    const communeOutage = Effect.fn("OutageService.commune")(
      function* (commune: Commune, geocode: boolean, fallbackBounds: Bounds) {
        const key = `commune-outages:${yield* sha256Hex(
          JSON.stringify({ code: commune.code, geocode }),
        )}`;
        const refresh = refreshCommune(key, commune, geocode, fallbackBounds);
        if (config.outageCacheTtl > 0) {
          const entry = yield* cache.get(key, CommuneOutageCacheSchema, 60)
            .pipe(Effect.catchTag("CacheError", () => Effect.succeed(null)));
          if (entry !== null) {
            const now = yield* Clock.currentTimeMillis;
            if (now < Date.parse(entry.freshUntil)) {
              return {
                ok: true,
                response: entry.response,
                cache: "HIT",
              } satisfies CommuneResult;
            }
            yield* background.schedule(
              refresh.pipe(
                Effect.asVoid,
                Effect.catch(() => Effect.void),
              ),
            );
            return {
              ok: true,
              response: entry.response,
              cache: "STALE",
            } satisfies CommuneResult;
          }
        }
        return {
          ok: true,
          response: yield* refresh,
          cache: "MISS",
        } satisfies CommuneResult;
      },
    );

    const viewport = Effect.fn("OutageService.viewport")(
      function* (
        bounds: Bounds,
        includeRaw: boolean,
        geocode: boolean,
        communeLimit?: number,
      ) {
        const visible = yield* communes.forBounds(bounds, 200);
        const selected = communesNearestCenter(visible, bounds).slice(
          0,
          communeLimit,
        );
        const results = yield* Effect.forEach(
          selected,
          (commune): Effect.Effect<CommuneResult, CryptoError> =>
            communeOutage(commune, geocode, bounds).pipe(
              Effect.catch((error) =>
                error._tag === "CryptoError"
                  ? Effect.fail(error)
                  : Effect.succeed(
                    {
                      ok: false,
                      warning: `${commune.name} (${commune.code}): ${
                        errorMessage(error)
                      }`,
                    } satisfies CommuneResult,
                  )
              ),
            ),
          { concurrency: 6 },
        );
        const successes: Array<
          {
            readonly ok: true;
            readonly response: OutageResponse;
            readonly cache: "HIT" | "STALE" | "MISS";
          }
        > = [];
        const warnings: Array<string> = [];
        for (const item of results) {
          if ("warning" in item) warnings.push(item.warning);
          else successes.push(item);
        }
        if (successes.length === 0 && warnings.length > 0) {
          return yield* AllCommunesFailed.make({
            warnings,
            message: "all visible commune requests failed",
          });
        }
        const merged = mergeOutageResponses(
          successes.map((item) => item.response),
        );
        const response: OutageResponse = {
          ...merged,
          viewport: bounds,
          communes: responseCommunes(selected),
          communeTotal: visible.length,
          warnings: [
            ...warnings,
            ...(includeRaw
              ? ["raw Enedis payloads are omitted for viewport aggregation"]
              : []),
          ],
        };
        return {
          response,
          cache: "MISS",
          communeStats: {
            hits: successes.filter((item) => item.cache === "HIT").length,
            stale: successes.filter((item) => item.cache === "STALE").length,
            misses: warnings.length +
              successes.filter((item) => item.cache === "MISS").length,
          },
        } satisfies Result;
      },
    );

    return { single, viewport };
  }),
);

function communesNearestCenter(
  communes: ReadonlyArray<Commune>,
  bounds: Bounds,
): Array<Commune> {
  const targetLat = (bounds.south + bounds.north) / 2;
  const targetLng = (bounds.west + bounds.east) / 2;

  return [...communes].sort((left, right) => {
    const distance = communeDistance(left, targetLat, targetLng) -
      communeDistance(right, targetLat, targetLng);
    return distance === 0 ? left.code.localeCompare(right.code) : distance;
  });
}

function communeDistance(
  commune: Commune,
  targetLat: number,
  targetLng: number,
): number {
  const coordinates = commune.center?.coordinates;
  if (coordinates === undefined) return Number.POSITIVE_INFINITY;
  const lat = coordinates[1] - targetLat;
  const lng = coordinates[0] - targetLng;
  return lat * lat + lng * lng;
}
