import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { testExports } from "./session.js";

describe("verified session cookies", () => {
  it("emits host-only secure cookie attributes", () => {
    const cookie = testExports.serializeCookie(
      "__Host-outages_session",
      "signed-value",
      1800,
      true,
    );
    assert.include(cookie, "__Host-outages_session=signed-value");
    assert.include(cookie, "Path=/");
    assert.include(cookie, "HttpOnly");
    assert.include(cookie, "Secure");
    assert.include(cookie, "SameSite=Strict");
    assert.notInclude(cookie, "Domain=");
  });

  it("rejects duplicate session cookies", () => {
    const request = new Request("https://example.test", {
      headers: {
        Cookie: "session=first; other=value; session=second",
      },
    });
    assert.isTrue(Option.isNone(testExports.cookieValue(request, "session")));
  });
});
