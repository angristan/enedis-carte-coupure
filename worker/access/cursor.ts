import { Effect, Option, Schema } from "effect";
import type { Bounds } from "../domain/geo.js";
import { boundsCacheKey } from "../domain/geo.js";
import { CursorExpired, InvalidCursor } from "../domain/errors.js";
import { signJson, verifyJson } from "./signing.js";
import { sha256Hex } from "../domain/util.js";

export const COMMUNE_PAGE_SIZE = 6;
const MAX_CURSOR_LENGTH = 2048;

const CursorPayloadSchema = Schema.Struct({
  v: Schema.Literal(1),
  sessionTag: Schema.String,
  viewportKey: Schema.String,
  communeListDigest: Schema.String,
  nextOffset: Schema.Number,
  expiresAt: Schema.Number,
});

export interface CursorContext {
  readonly sessionTag: string;
  readonly bounds: Bounds;
  readonly communeCodes: ReadonlyArray<string>;
  readonly now: number;
  readonly ttlSeconds: number;
  readonly secret: string;
}

export interface PagePosition {
  readonly offset: number;
  readonly expiresAt: number;
}

const decodeCursor = Schema.decodeUnknownOption(CursorPayloadSchema);

export const pagePosition = Effect.fn("pagePosition")(function* (
  cursor: string | null,
  context: CursorContext,
) {
  if (cursor === null) {
    return {
      offset: 0,
      expiresAt: context.now + context.ttlSeconds * 1000,
    } satisfies PagePosition;
  }
  if (cursor.length > MAX_CURSOR_LENGTH) {
    return yield* InvalidCursor.make({ message: "cursor is too long" });
  }

  const verified = yield* verifyJson(cursor, context.secret);
  if (Option.isNone(verified)) {
    return yield* InvalidCursor.make({ message: "cursor is invalid" });
  }
  const decoded = decodeCursor(verified.value);
  if (Option.isNone(decoded)) {
    return yield* InvalidCursor.make({ message: "cursor is invalid" });
  }

  const payload = decoded.value;
  if (payload.expiresAt <= context.now) {
    return yield* CursorExpired.make({ message: "cursor has expired" });
  }
  const digest = yield* communeListDigest(context.communeCodes);
  if (
    payload.sessionTag !== context.sessionTag ||
    payload.viewportKey !== boundsCacheKey(context.bounds) ||
    payload.communeListDigest !== digest ||
    !Number.isInteger(payload.nextOffset) ||
    payload.nextOffset <= 0 ||
    payload.nextOffset % COMMUNE_PAGE_SIZE !== 0 ||
    payload.nextOffset >= context.communeCodes.length
  ) {
    return yield* InvalidCursor.make({ message: "cursor does not match request" });
  }

  return {
    offset: payload.nextOffset,
    expiresAt: payload.expiresAt,
  } satisfies PagePosition;
});

export const nextPageCursor = Effect.fn("nextPageCursor")(function* (
  nextOffset: number,
  expiresAt: number,
  context: CursorContext,
) {
  if (nextOffset >= context.communeCodes.length) return undefined;
  const digest = yield* communeListDigest(context.communeCodes);
  return yield* signJson({
    v: 1,
    sessionTag: context.sessionTag,
    viewportKey: boundsCacheKey(context.bounds),
    communeListDigest: digest,
    nextOffset,
    expiresAt,
  }, context.secret);
});

export const sessionTag = Effect.fn("cursor.sessionTag")(function* (
  sessionId: string,
) {
  return yield* sha256Hex(`cursor-session:${sessionId}`);
});

const communeListDigest = Effect.fn("cursor.communeListDigest")(function* (
  codes: ReadonlyArray<string>,
) {
  return yield* sha256Hex(codes.join(","));
});
