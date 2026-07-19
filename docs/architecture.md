# Architecture and data flow

The application is a React single-page app and a Cloudflare Worker deployed together. The Worker serves the built
assets and the API used by the browser.

## System overview

```text
Browser
  |  React + MapLibre
  |  Effect API client + shared Schema contract
  v
Cloudflare Worker
  |  thin Request/Response boundary
  v
OutageService
  +-- CommuneDirectory ------> geo.api.gouv.fr
  +-- Enedis ----------------> enedis.fr
  +-- Normalizer
  |     +-- Geocoder --------> GeoPF / api-adresse
  |     `-- StreetGeometry --> Overpass
  `-- KVStore ---------------> Workers KV
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
- `RawHttp` for abortable upstream requests, status classification, and Schema decoding;
- `KVStore` for prefixed, Schema-decoded KV values;
- provider services for communes, Enedis, geocoding, and street geometry;
- `Normalizer` for enrichment and the pure outage transformations;
- `OutageService` for response caching and request orchestration.

Reusable operations use `Effect.fn`; sequential workflows use `Effect.gen`. Expected failures are
`Schema.TaggedErrorClass` values. Cache failures are best-effort where the API can truthfully continue, provider
failures stay typed, and only the outer boundary handles defects as `500` responses.

Raw `fetch` remains the Cloudflare transport. `RawHttp` wraps it in `Effect.tryPromise`, forwards Effect's
`AbortSignal`, checks the HTTP status, parses JSON as `unknown`, and decodes the result before returning it.

## Viewport request flow

The browser sends the visible map bounds to `/api/outages`.

1. The Worker validates the request method and viewport.
2. `CommuneDirectory` checks the snapped viewport cache.
3. On a miss, it samples nine points and resolves them through `geo.api.gouv.fr`, with at most eight requests in
   flight.
4. The Worker deduplicates communes and rejects viewports crossing more than 30 communes.
5. `OutageService` loads each commune's normalized outage fact, with at most six communes in flight.
6. `Enedis` fetches and Schema-decodes the public outage payload.
7. `Normalizer` deduplicates incidents and streets, then geocodes streets with at most four lookups in flight.
8. `StreetGeometryProvider` loads missing OSM street geometry from a bounded Overpass query.
9. The Worker caches each commune fact and composes the viewport response.
10. The response is encoded through `OutageResponseSchema` before it leaves the Worker.

A failed commune becomes a warning when another commune succeeded. The request returns `502` only when every
required commune failed.

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
the current response when it remains covered. It also avoids starting a second request when the active request
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
| Single-query API response | Hashed `outages:*` entry with stale-while-revalidate | 15 minutes fresh; retained 24 hours |
| Per-commune outage fact | Hashed `commune-outages:*` entry with stale-while-revalidate | 15 minutes fresh; retained 24 hours |
| Snapped commune viewport | `communes:*` | 7 days |
| Geocode result | Hashed `geocode:*` entry | 30 days |
| Street geometry index | `streetgeom:streets:*` | 24 hours |

Stale response and commune entries schedule refreshes through `ctx.waitUntil()`. KV is a cache, not an authoritative
store: reads may be eventually consistent and cache read/write failures do not fail otherwise valid upstream work.

## Frontend structure

The frontend keeps React behavior idiomatic:

- `frontend/src/App.tsx` owns request and selection state;
- `frontend/src/api/client.ts` owns Effect cancellation, typed API errors, and Schema decoding;
- `frontend/src/map/MapView.tsx` owns MapLibre interaction state;
- `frontend/src/map/layers.ts` contains the MapLibre style definitions;
- `frontend/src/map/areaFeatures.ts`, `streetFeatures.ts`, `streetLines.ts`, and `spatial.ts` contain focused GeoJSON and geometry helpers;
- `frontend/src/map/geometry.ts` remains a small compatibility facade, while `viewport.ts` owns viewport reuse;
- `frontend/src/components/` contains the side panel and statistics;
- `frontend/src/domain/streets.ts` contains filtering and display logic.

Effect is used at the asynchronous and validation boundary; it does not replace React state or MapLibre events.
