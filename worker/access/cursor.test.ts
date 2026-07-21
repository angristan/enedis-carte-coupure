import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  nextPageCursor,
  pagePosition,
  sessionTag,
} from "./cursor.js";

const bounds = { south: 48.8, west: 2.2, north: 48.9, east: 2.4 };
const communeCodes = Array.from({ length: 13 }, (_, index) =>
  String(78000 + index)
);
const secret = "cursor-test-secret-with-at-least-32-bytes";

const context = {
  sessionTag: "session-a",
  bounds,
  communeCodes,
  now: 1_000_000,
  ttlSeconds: 600,
  secret,
};

describe("signed pagination cursors", () => {
  it.effect("round-trips fixed page offsets", () =>
    Effect.gen(function* () {
      const first = yield* pagePosition(null, context);
      assert.deepEqual(first, { offset: 0, expiresAt: 1_600_000 });

      const cursor = yield* nextPageCursor(6, first.expiresAt, context);
      assert.isString(cursor);
      if (cursor === undefined) return;
      const second = yield* pagePosition(cursor, context);
      assert.deepEqual(second, { offset: 6, expiresAt: 1_600_000 });

      const finalCursor = yield* nextPageCursor(12, second.expiresAt, context);
      assert.isString(finalCursor);
    }));

  it.effect("rejects tampering and session reuse", () =>
    Effect.gen(function* () {
      const cursor = yield* nextPageCursor(6, 1_600_000, context);
      if (cursor === undefined) return;
      const tampered = `${cursor.slice(0, -1)}x`;
      const tamperedError = yield* Effect.flip(pagePosition(tampered, context));
      assert.strictEqual(tamperedError._tag, "InvalidCursor");

      const sessionError = yield* Effect.flip(pagePosition(cursor, {
        ...context,
        sessionTag: "session-b",
      }));
      assert.strictEqual(sessionError._tag, "InvalidCursor");
    }));

  it.effect("expires cursors without extending the sequence", () =>
    Effect.gen(function* () {
      const cursor = yield* nextPageCursor(6, 1_000_001, context);
      if (cursor === undefined) return;
      const error = yield* Effect.flip(pagePosition(cursor, {
        ...context,
        now: 1_000_001,
      }));
      assert.strictEqual(error._tag, "CursorExpired");
    }));

  it.effect("derives stable session tags without exposing session IDs", () =>
    Effect.gen(function* () {
      const first = yield* sessionTag("private-session-id");
      const second = yield* sessionTag("private-session-id");
      assert.strictEqual(first, second);
      assert.notInclude(first, "private-session-id");
    }));
});
