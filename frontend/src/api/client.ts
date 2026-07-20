import { Effect, Option, Schema } from "effect";
import {
  ApiErrorResponseSchema,
  type OutageResponse,
  OutageResponseSchema,
  type SessionStatus,
  SessionStatusSchema,
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

export interface ApiLoadSuccess<Value> {
  readonly ok: true;
  readonly data: Value;
}

export interface ApiLoadFailure {
  readonly ok: false;
  readonly error: OutageApiError;
}

export type ApiLoadResult<Value> = ApiLoadSuccess<Value> | ApiLoadFailure;
export type OutageLoadResult = ApiLoadResult<OutageResponse>;

const VerificationResponseSchema = Schema.Struct({
  verified: Schema.Literal(true),
});
const decodeApiError = Schema.decodeUnknownOption(ApiErrorResponseSchema);

const requestJson = Effect.fn("OutageApi.requestJson")(
  function* <A>(
    url: string,
    init: RequestInit,
    schema: Schema.ConstraintDecoder<A, never>,
  ) {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { ...init, signal }),
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

    return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
      Effect.mapError((cause) =>
        ApiDecodeError.make({
          message: "La réponse du service des coupures est invalide.",
          cause,
        })
      ),
    );
  },
);

export const fetchOutages = Effect.fn("OutageApi.fetch")(
  function* (request: ViewportRequest) {
    return yield* requestJson(
      `/api/outages?${request.params.toString()}`,
      { headers: { accept: "application/json" } },
      OutageResponseSchema,
    );
  },
);

export const fetchSessionStatus = Effect.fn("OutageApi.sessionStatus")(
  function* () {
    return yield* requestJson(
      "/api/session",
      { headers: { accept: "application/json" } },
      SessionStatusSchema,
    );
  },
);

export const verifyTurnstile = Effect.fn("OutageApi.verifyTurnstile")(
  function* (turnstileToken: string) {
    yield* requestJson(
      "/api/session",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnstileToken }),
      },
      VerificationResponseSchema,
    );
  },
);

export function runOutageRequest(
  request: ViewportRequest,
  signal: AbortSignal,
): Promise<OutageLoadResult> {
  return runApiRequest(fetchOutages(request), signal);
}

export function runSessionStatusRequest(
  signal: AbortSignal,
): Promise<ApiLoadResult<SessionStatus>> {
  return runApiRequest(fetchSessionStatus(), signal);
}

export function runTurnstileVerification(
  token: string,
  signal: AbortSignal,
): Promise<ApiLoadResult<void>> {
  return runApiRequest(verifyTurnstile(token), signal);
}

function runApiRequest<Value>(
  effect: Effect.Effect<Value, OutageApiError>,
  signal: AbortSignal,
): Promise<ApiLoadResult<Value>> {
  return Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): ApiLoadResult<Value> => ({ ok: false, error }),
        onSuccess: (data): ApiLoadResult<Value> => ({ ok: true, data }),
      }),
    ),
    { signal },
  );
}
