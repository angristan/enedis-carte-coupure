import { Cause, Effect, Layer, Schema } from "effect";
import {
  ApiErrorResponseSchema,
  OutageResponseSchema,
  SessionStatusSchema,
  SessionVerificationRequestSchema,
} from "../shared/api.js";
import { viewportIsWithinLimits } from "../shared/viewport.js";
import { CommuneDirectoryLive } from "./providers/communes.js";
import { EnedisLive } from "./providers/enedis.js";
import type { RequestError } from "./domain/errors.js";
import {
  InvalidRequest,
  InvalidViewport,
  MethodNotAllowed,
  PayloadTooLarge,
  RouteNotFound,
  ViewportTooLarge,
} from "./domain/errors.js";
import { parseBounds } from "./domain/geo.js";
import { GeocoderLive } from "./providers/geocode.js";
import { NormalizerLive } from "./normalizer.js";
import {
  configLayer,
  type WorkerEnv,
} from "./platform/config.js";
import {
  backgroundTasksLayer,
  requestContextLayer,
} from "./platform/context.js";
import {
  RawHttpLive,
  upstreamCoordinatorLayer,
} from "./platform/http.js";
import { kvStoreLayer } from "./platform/kv.js";
import {
  type OutageResult,
  OutageService,
  OutageServiceLive,
} from "./service.js";
import { AccessControl, accessControlLayer } from "./access/session.js";
import { StreetGeometryProviderLive } from "./providers/streetgeom.js";
import type { CryptoError } from "./domain/util.js";

export { UpstreamCoordinator } from "./platform/upstream-coordinator.js";

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

  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      return yield* MethodNotAllowed.make({
        method: request.method,
        allow: "GET",
        message: "method not allowed",
      });
    }
    return json({ ok: true });
  }

  if (url.pathname === "/api/session") {
    const access = yield* AccessControl;
    if (request.method === "GET") {
      const status = yield* access.status(request);
      const encoded = yield* Schema.encodeUnknownEffect(SessionStatusSchema)(
        status,
      ).pipe(Effect.orDie);
      return json(encoded);
    }
    if (request.method === "POST") {
      yield* access.validateCreationRequest(request);
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
      allow: "GET, POST",
      message: "method not allowed",
    });
  }

  if (url.pathname !== "/api/outages") {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return yield* RouteNotFound.make({
        path: url.pathname,
        message: "API route not found",
      });
    }
    return null;
  }
  if (request.method !== "GET") {
    return yield* MethodNotAllowed.make({
      method: request.method,
      allow: "GET",
      message: "method not allowed",
    });
  }

  const access = yield* AccessControl;
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
  response.headers.set("X-App-Cache", "COMMUNE");
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
    case "MethodNotAllowed": {
      const response = apiError("METHOD_NOT_ALLOWED", error.message, 405);
      response.headers.set("Allow", error.allow);
      return response;
    }
    case "RouteNotFound":
      return apiError("NOT_FOUND", error.message, 404);
    case "PayloadTooLarge":
      return apiError("PAYLOAD_TOO_LARGE", error.message, 413);
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
    Effect.map((response) =>
      response ?? new Response("Not found\n", { status: 404 })
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
): Response {
  const body = Schema.encodeUnknownSync(ApiErrorResponseSchema)({
    error,
    message,
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

const MAX_JSON_REQUEST_BYTES = 4 * 1024;

const decodeJsonRequest = Effect.fn("Worker.decodeJsonRequest")(
  function* <A>(
    request: Request,
    schema: Schema.ConstraintDecoder<A, never>,
  ) {
    const contentLength = request.headers.get("Content-Length");
    if (
      contentLength !== null &&
      Number.isFinite(Number(contentLength)) &&
      Number(contentLength) > MAX_JSON_REQUEST_BYTES
    ) {
      return yield* PayloadTooLarge.make({
        maximumBytes: MAX_JSON_REQUEST_BYTES,
        message: "request body is too large",
      });
    }

    const body = yield* readLimitedBody(request, MAX_JSON_REQUEST_BYTES);
    if (body.tooLarge) {
      return yield* PayloadTooLarge.make({
        maximumBytes: MAX_JSON_REQUEST_BYTES,
        message: "request body is too large",
      });
    }

    const unknownJson = yield* Effect.try({
      try: (): unknown => JSON.parse(body.text),
      catch: () => InvalidRequest.make({ message: "invalid JSON request" }),
    });
    return yield* Schema.decodeUnknownEffect(schema)(unknownJson).pipe(
      Effect.mapError(() =>
        InvalidRequest.make({ message: "invalid JSON request" })
      ),
    );
  },
);

type LimitedBody =
  | { readonly tooLarge: false; readonly text: string }
  | { readonly tooLarge: true };

function readLimitedBody(
  request: Request,
  maximumBytes: number,
): Effect.Effect<LimitedBody, InvalidRequest> {
  return Effect.tryPromise({
    try: async (): Promise<LimitedBody> => {
      if (request.body === null) {
        return { tooLarge: false, text: "" };
      }

      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let text = "";

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          return {
            tooLarge: false,
            text: text + decoder.decode(),
          };
        }

        size += chunk.value.byteLength;
        if (size > maximumBytes) {
          try {
            await reader.cancel();
          } catch {
            // The size violation remains authoritative if cancellation fails.
          }
          return { tooLarge: true };
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
    catch: () => InvalidRequest.make({ message: "could not read request body" }),
  });
}

export const testExports = {
  errorResponse,
  handleApi,
  invalidOutageParameter,
};
