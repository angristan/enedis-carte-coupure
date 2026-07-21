import { Context, Effect, Layer, Schema } from "effect";
import {
  UpstreamDecodeError,
  type UpstreamError,
  UpstreamStatusError,
  UpstreamTransportError,
} from "../domain/errors.js";
import { RequestContext } from "./context.js";
import type { WorkerEnv } from "./config.js";
import type { TraceAttributes } from "./trace.js";
import { tracedPromise } from "./trace.js";
import { CoordinatedResultSchema } from "./upstream-coordinator.js";
import type {
  CoordinatedRequest,
  CoordinatedResult,
} from "./upstream-coordinator.js";

export interface HttpRequest {
  readonly provider: string;
  readonly operation: string;
  readonly url: string | URL;
  readonly init?: RequestInit;
  readonly attributes?: TraceAttributes;
  readonly dedupeKey?: string;
}

export class UpstreamCoordinatorClient
  extends Context.Service<UpstreamCoordinatorClient, {
    readonly request: (
      request: CoordinatedRequest,
      attributes?: TraceAttributes,
    ) => Effect.Effect<CoordinatedResult, UpstreamError>;
  }>()("UpstreamCoordinatorClient") {}

export function upstreamCoordinatorLayer(env: WorkerEnv) {
  return Layer.effect(UpstreamCoordinatorClient)(Effect.gen(function* () {
    const requestContext = yield* RequestContext;

    return {
      request: (request, attributes) => {
        const namespace = env.UPSTREAM_COORDINATOR;
        if (namespace === undefined) {
          return Effect.fail(UpstreamTransportError.make({
            provider: request.provider,
            operation: request.operation,
            cause: new Error("UPSTREAM_COORDINATOR binding is unavailable"),
          }));
        }

        const stub = namespace.get(namespace.idFromName(request.provider));
        return Effect.tryPromise({
          try: () =>
            tracedPromise(
              requestContext.trace,
              "upstream.request",
              {
                ...attributes,
                "upstream.provider": request.provider,
                "upstream.operation": request.operation,
              },
              async () => {
                const response = await stub.fetch(
                  "https://coordinator.internal/request",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(request),
                  },
                );
                if (!response.ok) {
                  throw new Error(`coordinator returned ${response.status}`);
                }
                return response.json();
              },
            ),
          catch: (cause) =>
            UpstreamTransportError.make({
              provider: request.provider,
              operation: request.operation,
              cause,
            }),
        }).pipe(
          Effect.flatMap((payload) =>
            Schema.decodeUnknownEffect(CoordinatedResultSchema)(payload).pipe(
              Effect.mapError((cause) =>
                UpstreamDecodeError.make({
                  provider: request.provider,
                  message: cause.message,
                })
              ),
            )
          ),
        );
      },
    };
  }));
}

export class RawHttp extends Context.Service<RawHttp, {
  readonly json: <A>(
    request: HttpRequest,
    schema: Schema.ConstraintDecoder<A, never>,
  ) => Effect.Effect<A, UpstreamError>;
}>()("RawHttp") {}

export const RawHttpLive = Layer.effect(RawHttp)(Effect.gen(function* () {
  const coordinator = yield* UpstreamCoordinatorClient;

  const acceptOutcome = Effect.fn("RawHttp.acceptOutcome")(
    function* (request: HttpRequest, outcome: CoordinatedResult) {
      if (outcome.ok) return outcome;
      if (outcome.reason === "budget" || outcome.reason === "concurrency") {
        return yield* UpstreamStatusError.make({
          provider: request.provider,
          status: 429,
          message: `${outcome.message}; retry after ${outcome.retryAfter}s`,
        });
      }
      return yield* UpstreamTransportError.make({
        provider: request.provider,
        operation: request.operation,
        cause: new Error(outcome.message),
      });
    },
  );

  const json = Effect.fn("RawHttp.json")(
    function* <A>(
      request: HttpRequest,
      schema: Schema.ConstraintDecoder<A, never>,
    ) {
      const coordinatedRequest = yield* serializeHttpRequest(request);
      const outcome = yield* coordinator.request(
        coordinatedRequest,
        request.attributes,
      );
      const result = yield* acceptOutcome(request, outcome);

      if (result.status < 200 || result.status >= 300) {
        return yield* UpstreamStatusError.make({
          provider: request.provider,
          status: result.status,
          message:
            `${request.provider} returned ${result.status} ${result.statusText}: ${
              result.text.slice(0, 180)
            }`,
        });
      }

      const unknownJson = yield* Effect.try({
        try: (): unknown => JSON.parse(result.text),
        catch: (cause) =>
          UpstreamDecodeError.make({
            provider: request.provider,
            message: `invalid JSON: ${String(cause)}`,
          }),
      });

      return yield* Schema.decodeUnknownEffect(schema)(unknownJson).pipe(
        Effect.mapError((error) =>
          UpstreamDecodeError.make({
            provider: request.provider,
            message: error.message,
          })
        ),
      );
    },
  );

  return { json };
}));

const serializeHttpRequest = Effect.fn("RawHttp.serialize")(function* (
  request: HttpRequest,
) {
  const body = yield* serializeBody(request);
  const method = request.init?.method?.toUpperCase() ?? "GET";
  const url = String(request.url);
  return {
    provider: request.provider,
    operation: request.operation,
    key: request.dedupeKey ?? `${method}:${url}:${body ?? ""}`,
    url,
    method,
    headers: Object.fromEntries(new Headers(request.init?.headers).entries()),
    ...(body === undefined ? {} : { body }),
  } satisfies CoordinatedRequest;
});

function serializeBody(
  request: HttpRequest,
): Effect.Effect<string | undefined, UpstreamTransportError> {
  const body = request.init?.body;
  if (body === undefined || body === null) return Effect.succeed(undefined);
  if (typeof body === "string") return Effect.succeed(body);
  if (body instanceof URLSearchParams) return Effect.succeed(body.toString());
  return Effect.fail(UpstreamTransportError.make({
    provider: request.provider,
    operation: request.operation,
    cause: new Error("unsupported coordinated request body"),
  }));
}
