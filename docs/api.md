# API reference

The API is served from `https://enedis.stanislas.cloud`. Successful and error responses are JSON with
`Cache-Control: no-store`. The shared contract is defined in `shared/api.ts` and decoded by both the Worker and the
browser with Effect Schema.

## `GET /api/health`

Unauthenticated liveness endpoint:

```json
{"ok":true}
```

## Verified sessions

Outage data requires a short-lived session created after Cloudflare Turnstile verification. The session is stored
in an HttpOnly cookie; clients should not attempt to parse it.

### `GET /api/session`

Reports whether the request already has a valid session. When verification is needed, it also returns the public
Turnstile site key:

```json
{
  "verified": false,
  "turnstileSiteKey": "0x4AAAA..."
}
```

A verified request returns:

```json
{"verified":true}
```

### `POST /api/session`

Verifies one Turnstile token:

```json
{"turnstileToken":"..."}
```

On success, the response is `{"verified":true}` and sets `__Host-outages_session` with `Path=/`, `HttpOnly`,
`Secure`, `SameSite=Strict`, and a 30-minute lifetime. Production verification checks the Turnstile action and
hostname. The managed widget also grants Cloudflare challenge clearance, so progressive page requests do not need
additional Turnstile tokens.

Requests with an unexpected `Origin` or invalid Turnstile result are rejected.

## `GET /api/outages`

Returns one fixed page containing at most six communes. A verified session and all four viewport bounds are
required:

```text
/api/outages?south=48.815&west=2.224&north=48.902&east=2.470
```

If `nextCursor` is present in the response, pass it unchanged with the same bounds:

```text
/api/outages?south=48.815&west=2.224&north=48.902&east=2.470&cursor=eyJ...
```

The cursor is opaque, signed, expires after 10 minutes, and is bound to the session, canonical viewport, ordered
commune set, and page offset. It cannot be reused for another session or viewport. Page size is controlled by the
server.

### Accepted query parameters

| Parameter | Meaning |
| --- | --- |
| `south`, `west`, `north`, `east` | Required viewport bounds |
| `cursor` | Optional opaque cursor returned by the previous page |

Unknown parameters are rejected. The API does not expose single-commune mode, raw upstream payloads, alternate
`bbox` syntax, geocoding controls, or caller-selected commune limits. Only `GET` is accepted.

### Response fields

| Field | Description |
| --- | --- |
| `updatedAt` | Latest normalization time represented by the page |
| `source` | Upstream endpoint metadata |
| `query`, `queries` | Enedis commune queries represented by the page |
| `viewport` | Canonical requested bounds |
| `communes` | This page's communes and contours, at most six |
| `communeTotal` | Total intersecting communes across all pages |
| `nextCursor` | Opaque next-page cursor; absent on the final page |
| `polygon` | Outage polygons for this page |
| `stats` | Page-local incident, street, geocoding, and geometry totals |
| `outages` | Normalized page-local incidents |
| `streets` | Deduplicated page-local affected streets |
| `warnings` | Non-fatal upstream, budget, or commune failures |
| `recap`, `crises` | Additional Enedis summary data when present |

The browser stores pages by cursor identity and recomputes the merged map state. Retrying a page therefore does not
double-count outages, streets, or statistics.

A provider or budget failure is isolated where possible. Fresh or retained stale commune data is preferred;
otherwise the page remains successful with warnings so pagination can continue.

### Cache headers

| Header | Meaning |
| --- | --- |
| `X-App-Cache: COMMUNE` | The page was composed from per-commune facts |
| `X-App-Cache-Commune-Hits` | Fresh commune cache hits |
| `X-App-Cache-Commune-Stale` | Retained stale facts served while refreshing |
| `X-App-Cache-Commune-Misses` | Synchronous refresh attempts, including failures |

### Errors

```json
{
  "error": "INVALID_VIEWPORT",
  "message": "viewport bounds are required"
}
```

| Status | Code or condition |
| --- | --- |
| `400` | `INVALID_REQUEST`, `INVALID_VIEWPORT`, `VIEWPORT_TOO_LARGE`, `TOO_MANY_COMMUNES`, or `INVALID_CURSOR` |
| `401` | `VERIFICATION_REQUIRED` |
| `403` | `VERIFICATION_FAILED` |
| `405` | `METHOD_NOT_ALLOWED` |
| `410` | `CURSOR_EXPIRED`; restart pagination from the first page |
| `429` | `RATE_LIMITED`, with `Retry-After` |
| `502` | A non-degradable upstream transport, status, or decode failure |
| `500` | Internal cryptographic or Worker failure |

The Worker rate limit is keyed by the verified random session ID, not caller-controlled input.
