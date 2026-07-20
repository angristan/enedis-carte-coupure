import { Cause, Effect, Layer, Schema } from "effect";
import {
  ApiErrorResponseSchema,
  OutageResponseSchema,
  SessionStatusSchema,
  SessionVerificationRequestSchema,
} from "../shared/api.js";
import { viewportIsWithinLimits } from "../shared/viewport.js";
import { CommuneDirectoryLive } from "./communes.js";
import { EnedisLive } from "./enedis.js";
import type { RequestError } from "./errors.js";
import {
  InvalidRequest,
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
  upstreamCoordinatorLayer,
  WorkerConfig,
  type WorkerEnv,
} from "./platform.js";
import {
  type OutageResult,
  OutageService,
  OutageServiceLive,
} from "./service.js";
import { AccessControl, accessControlLayer } from "./session.js";
import { StreetGeometryProviderLive } from "./streetgeom.js";
import type { CryptoError } from "./util.js";

export { UpstreamCoordinator } from "./upstream-coordinator.js";

type HandlerError = RequestError | CryptoError;

const run = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(effect);

function appLayer(env: WorkerEnv, context: ExecutionContext) {
  const base = Layer.mergeAll(
    configLayer(env),
    requestContextLayer(context),
    backgroundTasksLayer(context, run),
  );
  const coordinator = upstreamCoordinatorLayer(env).pipe(
    Layer.provideMerge(base),
  );
  const storage = kvStoreLayer(env.CACHE).pipe(Layer.provideMerge(coordinator));
  const infrastructure = RawHttpLive.pipe(Layer.provideMerge(storage));
  const adapters = Layer.mergeAll(
    EnedisLive,
    CommuneDirectoryLive,
    GeocoderLive,
    StreetGeometryProviderLive,
  ).pipe(Layer.provideMerge(infrastructure));
  const normalization = NormalizerLive.pipe(Layer.provideMerge(adapters));
  return Layer.mergeAll(
    OutageServiceLive,
    accessControlLayer(env),
  ).pipe(Layer.provide(normalization));
}

const handleApi = Effect.fn("Worker.handleApi")(function* (request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return json({ ok: true });

  const access = yield* AccessControl;
  if (url.pathname === "/api/session") {
    if (request.method === "GET") {
      const status = yield* access.status(request);
      const encoded = yield* Schema.encodeUnknownEffect(SessionStatusSchema)(
        status,
      ).pipe(Effect.orDie);
      return json(encoded);
    }
    if (request.method === "POST") {
      const payload = yield* decodeJsonRequest(
        request,
        SessionVerificationRequestSchema,
      );
      const created = yield* access.create(request, payload.turnstileToken);
      const response = json({ verified: true });
      response.headers.set("Set-Cookie", created.cookie);
      return response;
    }
    return yield* MethodNotAllowed.make({
      method: request.method,
      message: "method not allowed",
    });
  }

  if (url.pathname !== "/api/outages") return null;
  if (request.method !== "GET") {
    return yield* MethodNotAllowed.make({
      method: request.method,
      message: "method not allowed",
    });
  }
  const invalidParameter = invalidOutageParameter(url.searchParams);
  if (invalidParameter !== undefined) {
    return yield* InvalidRequest.make({ message: invalidParameter });
  }

  const parsed = parseBounds(url.searchParams);
  if (!parsed.hasBounds) {
    return yield* InvalidViewport.make({
      message: "viewport bounds are required",
    });
  }
  if ("error" in parsed) {
    return yield* InvalidViewport.make({ message: parsed.error });
  }
  if (!viewportIsWithinLimits(parsed.bounds)) {
    return yield* ViewportTooLarge.make({
      message: "viewport is too large; zoom in",
    });
  }

  const session = yield* access.require(request);
  yield* access.limit(session);
  const service = yield* OutageService;
  const result = yield* service.viewport(
    parsed.bounds,
    url.searchParams.get("cursor"),
    session.id,
  );

  const encoded = yield* Schema.encodeUnknownEffect(OutageResponseSchema)(
    result.response,
  ).pipe(Effect.orDie);
  const response = json(encoded);
  setCacheHeaders(response, result);
  return response;
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
    case "InvalidRequest":
      return apiError("INVALID_REQUEST", error.message, 400);
    case "InvalidCursor":
      return apiError("INVALID_CURSOR", error.message, 400);
    case "CursorExpired":
      return apiError("CURSOR_EXPIRED", error.message, 410);
    case "VerificationRequired":
      return apiError("VERIFICATION_REQUIRED", error.message, 401);
    case "VerificationFailed":
      return apiError("VERIFICATION_FAILED", error.message, 403);
    case "RateLimitExceeded": {
      const response = apiError("RATE_LIMITED", error.message, 429);
      response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
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

const OUTAGE_PARAMETERS = new Set([
  "south",
  "west",
  "north",
  "east",
  "cursor",
]);

function invalidOutageParameter(values: URLSearchParams): string | undefined {
  for (const key of values.keys()) {
    if (!OUTAGE_PARAMETERS.has(key)) return `unsupported parameter: ${key}`;
    if (values.getAll(key).length !== 1) return `duplicate parameter: ${key}`;
  }
  return undefined;
}

const decodeJsonRequest = Effect.fn("Worker.decodeJsonRequest")(
  function* <A>(
    request: Request,
    schema: Schema.ConstraintDecoder<A, never>,
  ) {
    const unknownJson = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => InvalidRequest.make({ message: "invalid JSON request" }),
    });
    return yield* Schema.decodeUnknownEffect(schema)(unknownJson).pipe(
      Effect.mapError(() =>
        InvalidRequest.make({ message: "invalid JSON request" })
      ),
    );
  },
);

export const testExports = { errorResponse, invalidOutageParameter };
