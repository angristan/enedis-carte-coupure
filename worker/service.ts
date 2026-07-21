import { Clock, Context, Effect, Layer } from "effect";
import { errorMessage, type RequestError } from "./domain/errors.js";
import {
  boundsForCommune,
  CommuneDirectory,
  enedisQueryForCommune,
} from "./providers/communes.js";
import { Enedis } from "./providers/enedis.js";
import type { Bounds } from "./domain/geo.js";
import {
  type Commune,
  CommuneOutageCacheSchema,
  type OutageResponse,
} from "./domain/models.js";
import {
  mergeOutageResponses,
  Normalizer,
  responseCommunes,
} from "./normalizer.js";
import { WorkerConfig } from "./platform/config.js";
import { BackgroundTasks } from "./platform/context.js";
import { KVStore } from "./platform/kv.js";
import {
  COMMUNE_PAGE_SIZE,
  nextPageCursor,
  pagePosition,
  sessionTag,
} from "./access/cursor.js";
import { type CryptoError, sha256Hex } from "./domain/util.js";

export interface OutageResult {
  readonly response: OutageResponse;
  readonly communeStats: {
    readonly hits: number;
    readonly stale: number;
    readonly misses: number;
  };
}
type ServiceError = RequestError | CryptoError;

type CommuneResult = {
  readonly ok: true;
  readonly response: OutageResponse;
  readonly cache: "HIT" | "STALE" | "MISS";
} | { readonly ok: false; readonly warning: string };

export class OutageService extends Context.Service<OutageService, {
  readonly viewport: (
    bounds: Bounds,
    cursor: string | null,
    sessionId: string,
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

    const refreshCommune = Effect.fn("OutageService.refreshCommune")(
      function* (
        key: string,
        commune: Commune,
        fallbackBounds: Bounds,
      ) {
        const query = enedisQueryForCommune(commune);
        const raw = yield* enedis.fetch(query);
        let response = yield* normalizer.normalizeSet([{ raw, query }], {
          geocode: true,
        });
        const geometryBounds = boundsForCommune(commune, fallbackBounds);
        if (geometryBounds !== undefined) {
          response = yield* normalizer.attachGeometry(response, geometryBounds).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                ...response,
                warnings: [
                  ...(response.warnings ?? []),
                  `Street geometry unavailable: ${errorMessage(error)}`,
                ],
              })
            ),
          );
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
      function* (commune: Commune, fallbackBounds: Bounds) {
        const key = `commune-outages:${yield* sha256Hex(
          JSON.stringify({ code: commune.code, geocode: true }),
        )}`;
        const refresh = refreshCommune(key, commune, fallbackBounds);
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
      function* (bounds: Bounds, cursor: string | null, sessionId: string) {
        const visible = communesNearestCenter(
          yield* communes.forBounds(bounds, 200),
          bounds,
        );
        const codes = visible.map((commune) => commune.code);
        const now = yield* Clock.currentTimeMillis;
        const tag = yield* sessionTag(sessionId);
        const cursorContext = {
          sessionTag: tag,
          bounds,
          communeCodes: codes,
          now,
          ttlSeconds: config.cursorTtl,
          secret: config.cursorSigningSecret,
        };
        const position = yield* pagePosition(cursor, cursorContext);
        const selected = visible.slice(
          position.offset,
          position.offset + COMMUNE_PAGE_SIZE,
        );
        const results = yield* Effect.forEach(
          selected,
          (commune): Effect.Effect<CommuneResult, CryptoError> =>
            communeOutage(commune, bounds).pipe(
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
        const failedCommuneWarnings: Array<string> = [];
        for (const item of results) {
          if ("warning" in item) failedCommuneWarnings.push(item.warning);
          else successes.push(item);
        }
        const merged = mergeOutageResponses(
          successes.map((item) => item.response),
        );
        const nextOffset = position.offset + selected.length;
        const nextCursor = yield* nextPageCursor(
          nextOffset,
          position.expiresAt,
          cursorContext,
        );
        const pageWarnings = Array.from(new Set([
          ...(merged.warnings ?? []),
          ...failedCommuneWarnings,
        ]));
        const response: OutageResponse = {
          ...merged,
          viewport: bounds,
          communes: responseCommunes(selected),
          communeTotal: visible.length,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          ...(pageWarnings.length === 0 ? {} : { warnings: pageWarnings }),
        };
        return {
          response,
          communeStats: {
            hits: successes.filter((item) => item.cache === "HIT").length,
            stale: successes.filter((item) => item.cache === "STALE").length,
            misses: failedCommuneWarnings.length +
              successes.filter((item) => item.cache === "MISS").length,
          },
        } satisfies OutageResult;
      },
    );

    return { viewport };
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
