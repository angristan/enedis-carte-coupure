import { Effect, Option, Schema } from "effect";
import {
  ApiErrorResponseSchema,
  type OutageResponse,
  OutageResponseSchema,
} from "../../../shared/api.js";
import type { ViewportRequest } from "../map/viewport.js";

export class ApiTransportError
  extends Schema.TaggedErrorClass<ApiTransportError>()(
    "ApiTransportError",
    {
      message: Schema.String,
      cause: Schema.Defect(),
    },
  ) {}

export class ApiStatusError extends Schema.TaggedErrorClass<ApiStatusError>()(
  "ApiStatusError",
  {
    status: Schema.Number,
    message: Schema.String,
  },
) {}

export class ApiDecodeError extends Schema.TaggedErrorClass<ApiDecodeError>()(
  "ApiDecodeError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type OutageApiError =
  | ApiTransportError
  | ApiStatusError
  | ApiDecodeError;

export interface OutageLoadSuccess {
  readonly ok: true;
  readonly data: OutageResponse;
}

export interface OutageLoadFailure {
  readonly ok: false;
  readonly error: OutageApiError;
}

export type OutageLoadResult = OutageLoadSuccess | OutageLoadFailure;

const decodeApiError = Schema.decodeUnknownOption(ApiErrorResponseSchema);

export const fetchOutages = Effect.fn("OutageApi.fetch")(
  function* (request: ViewportRequest) {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`/api/outages?${request.params.toString()}`, {
          signal,
          headers: { accept: "application/json" },
        }),
      catch: (cause) =>
        ApiTransportError.make({
          message: "Impossible de contacter le service des coupures.",
          cause,
        }),
    });

    if (!response.ok) {
      const payload = yield* Effect.promise(async () => {
        try {
          return await response.json();
        } catch {
          return undefined;
        }
      });
      const decoded = decodeApiError(payload);
      const message = Option.isSome(decoded)
        ? decoded.value.message
        : `HTTP ${response.status}`;
      return yield* ApiStatusError.make({ status: response.status, message });
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        ApiDecodeError.make({
          message: "La réponse du service n'est pas un document JSON valide.",
          cause,
        }),
    });

    return yield* Schema.decodeUnknownEffect(OutageResponseSchema)(payload)
      .pipe(
        Effect.mapError((cause) =>
          ApiDecodeError.make({
            message: "La réponse du service des coupures est invalide.",
            cause,
          })
        ),
      );
  },
);

export function runOutageRequest(
  request: ViewportRequest,
  signal: AbortSignal,
): Promise<OutageLoadResult> {
  const result = fetchOutages(request).pipe(
    Effect.match({
      onFailure: (error): OutageLoadResult => ({ ok: false, error }),
      onSuccess: (data): OutageLoadResult => ({ ok: true, data }),
    }),
  );
  return Effect.runPromise(result, { signal });
}
