import { Cause, Effect, Layer, Schema } from "effect";
import { ApiErrorResponseSchema, OutageResponseSchema } from "../shared/api.js";
import { viewportIsWithinLimits } from "../shared/viewport.js";
import { CommuneDirectoryLive } from "./communes.js";
import { EnedisLive, queryFromValues } from "./enedis.js";
import type { RequestError } from "./errors.js";
import {
  InvalidViewport,
  MethodNotAllowed,
  ViewportTooLarge,
} from "./errors.js";
import { parseBounds } from "./geo.js";
import { GeocoderLive } from "./geocode.js";
import { NormalizerLive } from "./outages.js";
import {
  BackgroundTasks,
  backgroundTasksLayer,
  configLayer,
  kvStoreLayer,
  RawHttpLive,
  requestContextLayer,
  WorkerConfig,
  type WorkerEnv,
} from "./platform.js";
import {
  type OutageResult,
  OutageService,
  OutageServiceLive,
} from "./service.js";
import { StreetGeometryProviderLive } from "./streetgeom.js";
import type { CryptoError } from "./util.js";

type HandlerError = RequestError | CryptoError;

const run = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(effect);

function appLayer(env: WorkerEnv, context: ExecutionContext) {
  const base = Layer.mergeAll(
    configLayer(env),
    requestContextLayer(context),
    backgroundTasksLayer(context, run),
  );
  const infrastructure = Layer.mergeAll(kvStoreLayer(env.CACHE), RawHttpLive)
    .pipe(Layer.provideMerge(base));
  const adapters = Layer.mergeAll(
    EnedisLive,
    CommuneDirectoryLive,
    GeocoderLive,
    StreetGeometryProviderLive,
  ).pipe(Layer.provideMerge(infrastructure));
  const normalization = NormalizerLive.pipe(Layer.provideMerge(adapters));
  return OutageServiceLive.pipe(Layer.provide(normalization));
}

const handleApi = Effect.fn("Worker.handleApi")(function* (request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return json({ ok: true });
  if (url.pathname !== "/api/outages") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return yield* MethodNotAllowed.make({
      method: request.method,
      message: "method not allowed",
    });
  }

  const service = yield* OutageService;
  const parsed = parseBounds(url.searchParams);
  const includeRaw = url.searchParams.get("raw") === "1";
  const geocode = url.searchParams.get("geocode") !== "0";

  let result;
  if (!parsed.hasBounds) {
    result = yield* service.single(
      queryFromValues(url.searchParams),
      includeRaw,
      geocode,
    );
  } else if ("error" in parsed) {
    return yield* InvalidViewport.make({ message: parsed.error });
  } else if (!viewportIsWithinLimits(parsed.bounds)) {
    return yield* ViewportTooLarge.make({
      message: "viewport is too large; zoom in",
    });
  } else {
    result = yield* service.viewport(parsed.bounds, includeRaw, geocode);
  }

  const encoded = yield* Schema.encodeUnknownEffect(OutageResponseSchema)(
    result.response,
  ).pipe(Effect.orDie);
  const response = json(encoded);
  setCacheHeaders(response, result);

  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
});

function setCacheHeaders(response: Response, result: OutageResult): void {
  response.headers.set(
    "X-App-Cache",
    result.communeStats === undefined ? result.cache : "COMMUNE",
  );

  if (result.refreshedAt !== undefined) {
    response.headers.set("X-App-Cache-Refreshed-At", result.refreshedAt);
  }
  if (result.freshUntil !== undefined) {
    response.headers.set("X-App-Cache-Fresh-Until", result.freshUntil);
  }
  if (result.cache === "STALE") {
    response.headers.set("X-App-Cache-Refresh", "background");
  }
  if (result.communeStats === undefined) return;

  response.headers.set(
    "X-App-Cache-Commune-Hits",
    String(result.communeStats.hits),
  );
  response.headers.set(
    "X-App-Cache-Commune-Stale",
    String(result.communeStats.stale),
  );
  response.headers.set(
    "X-App-Cache-Commune-Misses",
    String(result.communeStats.misses),
  );
}

function errorResponse(error: HandlerError): Response {
  switch (error._tag) {
    case "InvalidViewport":
      return apiError("INVALID_VIEWPORT", error.message, 400);
    case "ViewportTooLarge":
      return apiError("VIEWPORT_TOO_LARGE", error.message, 400);
    case "TooManyCommunes":
      return apiError("TOO_MANY_COMMUNES", error.message, 400);
    case "MethodNotAllowed":
      return apiError("METHOD_NOT_ALLOWED", error.message, 405);
    case "AllCommunesFailed":
      return apiError(
        "ENEDIS_FETCH_FAILED",
        error.message,
        502,
        error.warnings,
      );
    case "UpstreamTransportError":
      return apiError(
        "UPSTREAM_TRANSPORT_ERROR",
        `${error.provider} transport failed`,
        502,
      );
    case "UpstreamStatusError":
      return apiError(
        "UPSTREAM_STATUS_ERROR",
        `${error.provider} returned HTTP ${error.status}`,
        502,
      );
    case "UpstreamDecodeError":
      return apiError(
        "UPSTREAM_DECODE_ERROR",
        `${error.provider} returned an invalid response`,
        502,
      );
    case "CryptoError":
      return apiError("INTERNAL_ERROR", "could not create cache key", 500);
  }
}

function program(
  request: Request,
  env: WorkerEnv,
  context: ExecutionContext,
): Effect.Effect<Response> {
  return handleApi(request).pipe(
    Effect.provide(appLayer(env, context)),
    Effect.flatMap((response) =>
      response !== null ? Effect.succeed(response) : Effect.tryPromise({
        try: (signal) => env.ASSETS.fetch(request, { signal }),
        catch: () => new Response("asset request failed\n", { status: 500 }),
      })
    ),
    Effect.catch((error) =>
      Effect.succeed(error instanceof Response ? error : errorResponse(error))
    ),
    Effect.catchCause((cause) =>
      Effect.logError(Cause.pretty(cause)).pipe(
        Effect.as(apiError("INTERNAL_ERROR", "unexpected error", 500)),
      )
    ),
  );
}

export default {
  fetch(
    request: Request,
    env: WorkerEnv,
    context: ExecutionContext,
  ): Promise<Response> {
    return run(program(request, env, context));
  },
} satisfies ExportedHandler<WorkerEnv>;

function json(payload: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function apiError(
  error: string,
  message: string,
  status: number,
  warnings?: ReadonlyArray<string>,
): Response {
  const body = Schema.encodeUnknownSync(ApiErrorResponseSchema)({
    error,
    message,
    ...(warnings === undefined ? {} : { warnings }),
  });
  return json(body, status);
}

export const testExports = { errorResponse };
