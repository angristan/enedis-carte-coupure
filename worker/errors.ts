import { Schema } from "effect";

export class InvalidViewport
  extends Schema.TaggedErrorClass<InvalidViewport>()("InvalidViewport", {
    message: Schema.String,
  }) {}

export class ViewportTooLarge
  extends Schema.TaggedErrorClass<ViewportTooLarge>()("ViewportTooLarge", {
    message: Schema.String,
  }) {}

export class TooManyCommunes
  extends Schema.TaggedErrorClass<TooManyCommunes>()("TooManyCommunes", {
    maximum: Schema.Number,
    message: Schema.String,
  }) {}

export class MethodNotAllowed
  extends Schema.TaggedErrorClass<MethodNotAllowed>()("MethodNotAllowed", {
    method: Schema.String,
    message: Schema.String,
  }) {}

export class InvalidRequest
  extends Schema.TaggedErrorClass<InvalidRequest>()("InvalidRequest", {
    message: Schema.String,
  }) {}

export class InvalidCursor
  extends Schema.TaggedErrorClass<InvalidCursor>()("InvalidCursor", {
    message: Schema.String,
  }) {}

export class CursorExpired
  extends Schema.TaggedErrorClass<CursorExpired>()("CursorExpired", {
    message: Schema.String,
  }) {}

export class VerificationRequired
  extends Schema.TaggedErrorClass<VerificationRequired>()(
    "VerificationRequired",
    { message: Schema.String },
  ) {}

export class VerificationFailed
  extends Schema.TaggedErrorClass<VerificationFailed>()(
    "VerificationFailed",
    { message: Schema.String },
  ) {}

export class RateLimitExceeded
  extends Schema.TaggedErrorClass<RateLimitExceeded>()("RateLimitExceeded", {
    retryAfter: Schema.Number,
    message: Schema.String,
  }) {}

export class UpstreamTransportError
  extends Schema.TaggedErrorClass<UpstreamTransportError>()(
    "UpstreamTransportError",
    {
      provider: Schema.String,
      operation: Schema.String,
      cause: Schema.Defect(),
    },
  ) {}

export class UpstreamStatusError
  extends Schema.TaggedErrorClass<UpstreamStatusError>()(
    "UpstreamStatusError",
    {
      provider: Schema.String,
      status: Schema.Number,
      message: Schema.String,
    },
  ) {}

export class UpstreamDecodeError
  extends Schema.TaggedErrorClass<UpstreamDecodeError>()(
    "UpstreamDecodeError",
    {
      provider: Schema.String,
      message: Schema.String,
    },
  ) {}

export class CacheError
  extends Schema.TaggedErrorClass<CacheError>()("CacheError", {
    operation: Schema.String,
    key: Schema.String,
    cause: Schema.Defect(),
  }) {}

export class AllCommunesFailed
  extends Schema.TaggedErrorClass<AllCommunesFailed>()("AllCommunesFailed", {
    warnings: Schema.Array(Schema.String),
    message: Schema.String,
  }) {}

export type UpstreamError =
  | UpstreamTransportError
  | UpstreamStatusError
  | UpstreamDecodeError;
export type RequestError =
  | InvalidViewport
  | ViewportTooLarge
  | TooManyCommunes
  | MethodNotAllowed
  | InvalidRequest
  | InvalidCursor
  | CursorExpired
  | VerificationRequired
  | VerificationFailed
  | RateLimitExceeded
  | AllCommunesFailed
  | UpstreamError;

export function errorMessage(error: UpstreamError | CacheError): string {
  switch (error._tag) {
    case "UpstreamTransportError":
      return `${error.provider} transport failed`;
    case "UpstreamStatusError":
      return `${error.provider} returned HTTP ${error.status}`;
    case "UpstreamDecodeError":
      return `${error.provider} returned an invalid response`;
    case "CacheError":
      return `cache ${error.operation} failed for ${error.key}`;
  }
}
