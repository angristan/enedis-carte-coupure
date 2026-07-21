import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { CommuneDirectory } from "./providers/communes.js";
import { Enedis } from "./providers/enedis.js";
import { UpstreamStatusError } from "./domain/errors.js";
import type {
  Commune,
  EnedisQuery,
  OutageResponse,
} from "./domain/models.js";
import { Normalizer } from "./normalizer.js";
import { WorkerConfig } from "./platform/config.js";
import { BackgroundTasks } from "./platform/context.js";
import { MemoryKVLayer } from "./platform/memory-kv.js";
import { OutageService, OutageServiceLive } from "./service.js";

const bounds = {
  south: 48.8,
  west: 2.2,
  north: 48.9,
  east: 2.4,
};

const communes: ReadonlyArray<Commune> = Array.from(
  { length: 7 },
  (_, index) => ({
    name: `Commune ${index + 1}`,
    code: `7500${index + 1}`,
    postcodes: [`7500${index + 1}`],
    center: {
      type: "Point",
      coordinates: [2.3 + index * 0.001, 48.85],
    },
  }),
);

const ConfigTest = Layer.succeed(WorkerConfig)({
  cachePrefix: "test",
  outageCacheTtl: 0,
  outageStaleTtl: 3600,
  communesCacheTtl: 3600,
  production: false,
  appOrigin: "http://127.0.0.1:5173",
  turnstileSiteKey: "test",
  turnstileSecretKey: "test",
  turnstileHostname: "",
  sessionSigningSecret: "session-signing-secret-at-least-32-bytes",
  cursorSigningSecret: "cursor-signing-secret-at-least-32-bytes",
  sessionTtl: 1800,
  cursorTtl: 600,
});
const DirectoryTest = Layer.succeed(CommuneDirectory)({
  forBounds: () => Effect.succeed(communes),
});
function queryResponse(
  query: EnedisQuery,
  warnings: ReadonlyArray<string> = [],
): OutageResponse {
  return {
    updatedAt: "2026-07-21T08:00:00.000Z",
    source: {
      enedisEndpoint: "enedis",
      geocoderEndpoint: "geocoder",
      geocoderFallbackEndpoint: "geocoder-fallback",
      streetGeometryEndpoint: "geometry",
    },
    query,
    stats: {
      outages: 0,
      addressRows: 0,
      streets: 0,
      geocodedStreets: 0,
      geocodeMisses: 0,
      streetGeometry: 0,
      streetGeometryMisses: 0,
      compteurIncidentHTA: 0,
      compteurTravauxHTA: 0,
      compteurBT: 0,
    },
    outages: [],
    streets: [],
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  };
}

function serviceLayer(options: {
  readonly cacheTtl?: number;
  readonly failCode?: string;
  readonly warning?: string;
  readonly onFetch?: () => void;
  readonly onSchedule?: () => void;
}) {
  const EnedisTest = Layer.succeed(Enedis)({
    fetch: (query) =>
      Effect.sync(() => options.onFetch?.()).pipe(
        Effect.flatMap(() =>
          query.insee === options.failCode
            ? Effect.fail(UpstreamStatusError.make({
              provider: "Enedis",
              status: 503,
              message: "unavailable",
            }))
            : Effect.succeed({})
        ),
      ),
  });
  const NormalizerTest = Layer.succeed(Normalizer)({
    normalizeSet: (inputs) => {
      const query = inputs[0]?.query;
      return query === undefined
        ? Effect.die("missing normalization input")
        : Effect.succeed(queryResponse(
          query,
          options.warning === undefined ? [] : [`${options.warning}: ${query.city}`],
        ));
    },
    attachGeometry: (response) => Effect.succeed(response),
  });
  const BackgroundTest = Layer.succeed(BackgroundTasks)({
    schedule: () => Effect.sync(() => options.onSchedule?.()),
  });
  const dependencies = Layer.mergeAll(
    options.cacheTtl === undefined
      ? ConfigTest
      : Layer.succeed(WorkerConfig)({
        cachePrefix: "test",
        outageCacheTtl: options.cacheTtl,
        outageStaleTtl: 3600,
        communesCacheTtl: 3600,
        production: false,
        appOrigin: "http://127.0.0.1:5173",
        turnstileSiteKey: "test",
        turnstileSecretKey: "test",
        turnstileHostname: "",
        sessionSigningSecret: "session-signing-secret-at-least-32-bytes",
        cursorSigningSecret: "cursor-signing-secret-at-least-32-bytes",
        sessionTtl: 1800,
        cursorTtl: 600,
      }),
    DirectoryTest,
    EnedisTest,
    NormalizerTest,
    BackgroundTest,
    MemoryKVLayer,
  );
  return OutageServiceLive.pipe(Layer.provide(dependencies));
}

describe("outage service orchestration", () => {
  it.effect("preserves successful warnings, partial failures, and pagination", () => {
    const layer = serviceLayer({
      failCode: "75003",
      warning: "geometry degraded",
    });

    return Effect.gen(function* () {
      const service = yield* OutageService;
      const first = yield* service.viewport(bounds, null, "session-1");

      assert.strictEqual(first.response.communes?.length, 6);
      assert.strictEqual(first.response.communeTotal, 7);
      assert.isString(first.response.nextCursor);
      assert.strictEqual(first.communeStats.misses, 6);
      assert.include(
        first.response.warnings ?? [],
        "Commune 3 (75003): Enedis returned HTTP 503",
      );
      assert.include(
        first.response.warnings ?? [],
        "geometry degraded: Commune 1",
      );

      const second = yield* service.viewport(
        bounds,
        first.response.nextCursor ?? null,
        "session-1",
      );
      assert.deepEqual(
        second.response.communes?.map((commune) => commune.code),
        ["75007"],
      );
      assert.isUndefined(second.response.nextCursor);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports fresh commune cache hits without refetching", () => {
    let fetches = 0;
    const layer = serviceLayer({
      cacheTtl: 900,
      onFetch: () => {
        fetches += 1;
      },
    });

    return Effect.gen(function* () {
      const service = yield* OutageService;
      const first = yield* service.viewport(bounds, null, "session-2");
      const second = yield* service.viewport(bounds, null, "session-2");

      assert.deepEqual(first.communeStats, {
        hits: 0,
        stale: 0,
        misses: 6,
      });
      assert.deepEqual(second.communeStats, {
        hits: 6,
        stale: 0,
        misses: 0,
      });
      assert.strictEqual(fetches, 6);
    }).pipe(Effect.provide(layer));
  });

  it.effect("serves retained stale communes and schedules refreshes", () => {
    let fetches = 0;
    let scheduled = 0;
    const layer = serviceLayer({
      cacheTtl: 0.001,
      onFetch: () => {
        fetches += 1;
      },
      onSchedule: () => {
        scheduled += 1;
      },
    });

    return Effect.gen(function* () {
      const service = yield* OutageService;
      yield* service.viewport(bounds, null, "session-3");
      yield* TestClock.adjust("20 millis");
      const second = yield* service.viewport(bounds, null, "session-3");

      assert.deepEqual(second.communeStats, {
        hits: 0,
        stale: 6,
        misses: 0,
      });
      assert.strictEqual(fetches, 6);
      assert.strictEqual(scheduled, 6);
    }).pipe(Effect.provide(layer));
  });
});
