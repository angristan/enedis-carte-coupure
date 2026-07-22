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
        ? localizedApiError(decoded.value.error, response.status)
        : localizedHttpError(response.status);
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

function localizedApiError(error: string, status: number): string {
  switch (error) {
    case "INVALID_VIEWPORT":
      return "La zone affichée est invalide.";
    case "VIEWPORT_TOO_LARGE":
      return "Zoomez davantage pour afficher les coupures.";
    case "TOO_MANY_COMMUNES":
      return "La zone affichée contient trop de communes. Zoomez davantage.";
    case "METHOD_NOT_ALLOWED":
      return "Cette action n'est pas autorisée.";
    case "NOT_FOUND":
      return "Le service demandé est introuvable.";
    case "PAYLOAD_TOO_LARGE":
      return "La requête envoyée est trop volumineuse.";
    case "INVALID_REQUEST":
      return "La requête envoyée est invalide.";
    case "INVALID_CURSOR":
      return "La pagination des résultats est invalide. Rechargez la carte.";
    case "CURSOR_EXPIRED":
      return "Les résultats ont expiré. Rechargez la carte.";
    case "VERIFICATION_REQUIRED":
      return "Une vérification humaine est requise.";
    case "VERIFICATION_FAILED":
      return "La vérification humaine a échoué. Réessayez.";
    case "RATE_LIMITED":
      return "Trop de requêtes ont été envoyées. Patientez un instant avant de réessayer.";
    case "UPSTREAM_TRANSPORT_ERROR":
      return "Un service de données est temporairement inaccessible.";
    case "UPSTREAM_STATUS_ERROR":
      return "Un service de données est temporairement indisponible.";
    case "UPSTREAM_DECODE_ERROR":
      return "Un service de données a renvoyé une réponse invalide.";
    case "INTERNAL_ERROR":
      return "Une erreur interne est survenue. Réessayez plus tard.";
    default:
      return localizedHttpError(status);
  }
}

function localizedHttpError(status: number): string {
  return `La requête a échoué (HTTP ${status}).`;
}

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
