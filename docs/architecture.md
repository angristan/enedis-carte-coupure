# Architecture and data flow

The application is a React single-page app and a Cloudflare Worker deployed together. The Worker serves the built
assets and the API used by the browser.

## System overview

```text
Browser
  |  React + MapLibre
  |  Turnstile -> signed HttpOnly session
  |  Effect API client + shared Schema contract
  v
Cloudflare Worker
  |  strict viewport API + signed cursor + session rate limit
  v
OutageService ----------------------------> Workers KV
  +-- CommuneDirectory --+
  +-- Enedis ------------+--> UpstreamCoordinator Durable Object
  +-- Normalizer --------+      | token buckets + concurrency caps
        +-- Geocoder ----+      | in-flight coalescing + deadlines
        `-- StreetGeometry      v
                         IGN / Enedis / GeoPF / api-adresse / Overpass
```

The public data contract lives in `shared/api.ts`. The Worker encodes responses with that contract and the browser
decodes every successful API response with the same Schema before it reaches React state.

## Effect runtime

`worker/index.ts` is the runtime boundary. It creates the request layer graph, runs the request program once with
`Effect.runPromise`, and maps typed failures to HTTP responses.

The layer graph contains:

- `WorkerConfig` for decoded duration and cache settings;
- `RequestContext` for the native Cloudflare trace context;
- `BackgroundTasks` for work owned by `ExecutionContext.waitUntil()`;
- `AccessControl` for Turnstile verification, signed sessions, origin checks, and per-session rate limiting;
- `RawHttp` for coordinated upstream requests, status classification, and Schema decoding;
- `UpstreamCoordinatorClient` for the fail-closed Durable Object boundary;
- `KVStore` for prefixed, Schema-decoded KV values;
- provider services for communes, Enedis, geocoding, and street geometry;
- `Normalizer` for enrichment and the pure outage transformations;
- `OutageService` for response caching and request orchestration.

Reusable operations use `Effect.fn`; sequential workflows use `Effect.gen`. Expected failures are
`Schema.TaggedErrorClass` values. Cache failures are best-effort where the API can truthfully continue, provider
failures stay typed, and only the outer boundary handles defects as `500` responses.

`RawHttp` serializes requests to a provider-specific `UpstreamCoordinator` Durable Object. The coordinator is the
only component that calls external providers. It applies a persisted token bucket and concurrency cap, coalesces
identical in-flight work, briefly reuses successful responses, aborts requests at a provider-specific deadline,
and rejects oversized bodies. Coordinator failure never falls back to an unbudgeted direct request. `RawHttp`
classifies the returned status, parses JSON as `unknown`, and Schema-decodes it.

## Viewport request flow

The browser sends the visible map bounds to `/api/outages`.

1. The browser completes managed Turnstile once and receives a signed 30-minute HttpOnly session.
2. The Worker validates the `GET` method, exact query allowlist, and required viewport.
3. The Worker verifies the session and applies the native rate limit keyed by its random ID.
4. `CommuneDirectory` checks the snapped viewport cache and otherwise queries IGN for intersecting contours.
5. The Worker deduplicates communes and rejects viewports crossing more than 200 communes.
6. The first response contains the six communes nearest the viewport center and an opaque signed cursor.
7. The browser requests subsequent disjoint pages sequentially and stores each by cursor identity.
8. `OutageService` loads the page's normalized commune facts, with at most six communes in flight.
9. Enedis, geocoding, and Overpass work passes through the global provider coordinator.
10. The Worker caches each commune fact and composes only the current page.
11. The response is encoded through `OutageResponseSchema`; the browser recomputes merged state from unique pages.

The cursor binds the session, canonical bounds, commune-list digest, offset, and original expiry. Retries are
idempotent, and a cursor cannot be replayed for another session or viewport. Failed enrichment degrades to retained
stale data or warnings. Even an all-failed page remains traversable instead of stranding pagination.

## Abuse and cost controls

Protection is layered because browser-visible data cannot be made completely unharvestable:

- managed Turnstile grants challenge clearance and creates a signed application session;
- `/api/outages` accepts only bounded viewport pages of six communes;
- opaque HMAC cursors prevent arbitrary offsets and bind pagination to one session and viewport;
- the Workers Rate Limiting binding allows 60 outage pages per minute per verified session;
- provider-specific Durable Object budgets cap global request rate and concurrency;
- identical cold misses coalesce, response bodies and execution time are bounded, and stale KV facts remain usable;
- `workers.dev` and preview URLs are disabled, so only the custom hostname serves the Worker.

Cloudflare WAF rate limiting is intentionally not configured.

## Outage normalization

The pure normalization path:

- expands common street abbreviations;
- removes leading address numbers where they are not part of the street name;
- deduplicates incidents, addresses, and streets;
- combines outage dates and affected-household counts;
- aggregates incident counters;
- retains display labels even when geocoding or geometry lookup misses.

Provider-backed enrichment is separate from those transformations, so the pure behavior can be tested without a
runtime layer.

## Commune and browser reuse

The Worker stores snapped viewport results under `communes:*`. A shifted viewport that snaps to the same bounds
reuses that entry.

Responses also include commune contours. The browser samples the new map bounds against those contours and keeps
the current response when it remains covered. Coverage reuse starts only after all `communeTotal` communes have
loaded. Moving the map aborts the current cursor sequence, and a second request is avoided while the active request
already contains the new bounds.

## Geocoding and street geometry

The geocoder tries GeoPF first and `api-adresse.data.gouv.fr` second. Successful results and misses are stored under
per-query hashed keys; transient failures are not cached.

Street geometry is loaded from a primary and fallback Overpass endpoint. Queries are bounded, padded, snapped,
and batched by street name. Same-name OSM geometry is split into connected components and filtered around the
geocoded point to avoid selecting a distant road with the same name.

## Cache model

| Data | Key or strategy | Lifetime |
| --- | --- | --- |
| Legacy single-query response | Hashed `outages:*` entry, no longer publicly addressable | 15 minutes fresh; retained 7 days |
| Per-commune outage fact | Hashed `commune-outages:*` entry with stale-while-revalidate | 15 minutes fresh; retained 7 days |
| Snapped commune viewport | `communes:*` | 7 days |
| Geocode result | Hashed `geocode:*` entry | 30 days |
| Street geometry index | `streetgeom:streets:*` | 24 hours |

Stale response and commune entries schedule refreshes through `ctx.waitUntil()`. KV is a cache, not an authoritative
store: reads may be eventually consistent and cache read/write failures do not fail otherwise valid upstream work.

## Frontend structure

The frontend keeps React behavior idiomatic:

- `frontend/src/App.tsx` owns request and selection state;
- `frontend/src/api/client.ts` owns session calls, cursor-page requests, Effect cancellation, typed API errors, and Schema decoding;
- `frontend/src/domain/outagePages.ts` recomputes merged state from unique pages;
- `frontend/src/map/MapView.tsx` owns MapLibre interaction state;
- `frontend/src/map/layers.ts` contains the MapLibre style definitions;
- `frontend/src/map/areaFeatures.ts`, `streetFeatures.ts`, `streetLines.ts`, and `spatial.ts` contain focused GeoJSON and geometry helpers;
- `frontend/src/map/geometry.ts` remains a small compatibility facade, while `viewport.ts` owns viewport reuse;
- `frontend/src/components/` contains the side panel and statistics;
- `frontend/src/domain/streets.ts` contains filtering and display logic.

Effect is used at the asynchronous and validation boundary; it does not replace React state or MapLibre events.
