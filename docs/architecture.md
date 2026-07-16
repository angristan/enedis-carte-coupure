# Architecture and data flow

The application is a React single-page app and a Cloudflare Worker deployed together. The Worker is both the
static asset origin and the API used by the browser.

## System overview

```text
Browser
  |
  +-- application routes ------------------> Workers Static Assets
  |
  `-- /api/health, /api/outages ----------> Worker router
                                                |
                                                +-- visible-commune resolver
                                                |     +-- geo.api.gouv.fr
                                                |     `-- KV point/contour index
                                                |
                                                +-- Enedis client
                                                |     `-- one request per commune
                                                |
                                                +-- outage normalizer
                                                |     +-- deduplicate incidents
                                                |     +-- normalize street labels
                                                |     `-- merge statistics/polygons
                                                |
                                                +-- geocoder
                                                |     +-- GeoPF
                                                |     `-- api-adresse fallback
                                                |
                                                +-- street geometry provider
                                                |     +-- bounded Overpass query
                                                |     `-- same-name locality filter
                                                |
                                                `-- Workers KV
                                                      +-- outage responses
                                                      +-- per-commune facts
                                                      +-- commune contours
                                                      +-- geocoding index
                                                      `-- street geometry indexes
```

Non-API routes are served from the Vite build through Workers Static Assets. API routes run through
`worker/index.js` first.

## Viewport request flow

The browser sends the current map bounds to `/api/outages`. A viewport request follows these steps:

1. Validate the bounds and reject a viewport that is too large.
2. Sample nine points across the viewport, including its center and edges.
3. Resolve each point to a commune with `geo.api.gouv.fr`.
4. Reuse exact point matches or cached commune contours whenever possible.
5. Deduplicate the communes and stop if the viewport crosses more than 30 of them.
6. Fetch Enedis outage data for the visible communes, with at most six requests in flight.
7. Normalize each commune into incidents and affected streets.
8. Geocode street labels with at most four requests in flight.
9. Query Overpass for the missing street names inside a padded commune boundary.
10. Cache the normalized commune result and compose the viewport response.

A failed commune request becomes a warning rather than discarding successful results from the other communes. The
API returns an error only when all visible commune requests fail.

## Commune discovery and spatial reuse

Commune lookup is deliberately spatial rather than tied only to a viewport cache key.

The Worker stores:

- snapped viewport results under `communes:*`;
- exact sample-point results and commune contours under `communes:points`;
- a short in-isolate point cache for repeated lookups handled by the same Worker instance.

When an exact point is absent, the resolver checks whether it falls inside any cached commune contour. A contour
hit avoids an upstream lookup and is written back as an exact point entry. This makes shifted viewports cheap after
the surrounding communes have been learned.

The browser applies the same idea. Each response contains commune contours, and the frontend reuses the current
data when all sample points from the new map bounds remain inside those contours. It also avoids launching a new
request when an active request already covers the new bounds.

## Outage normalization

Enedis data is organized around incidents and address labels. The normalizer turns it into a stable map-oriented
response:

- street abbreviations such as `R.`, `BD`, and `AV` are expanded;
- leading street numbers and accents are normalized for matching;
- duplicate incidents, addresses, and streets are merged;
- outage start and estimated restoration times are combined;
- affected-household counts and incident counters are aggregated;
- polygons from multiple communes are combined into one feature collection;
- raw commune responses are composed into one viewport response.

The original human-readable labels remain available for the UI even when a street cannot be geocoded or matched
to OpenStreetMap geometry.

## Geocoding and street geometry

The geocoder tries the GeoPF endpoint first and falls back to `api-adresse.data.gouv.fr`. Successful lookups and
misses are cached; transient errors are not.

Street geometry is loaded from a primary and fallback Overpass endpoint. Queries are:

- limited to padded and snapped geographic bounds;
- restricted to the street names missing from the current index;
- batched to keep regular expressions manageable;
- tolerant of accents and common punctuation differences.

OpenStreetMap can contain the same road name in several disconnected places. After a street is geocoded, the
geometry provider groups connected line components and keeps the components closest to the geocoded point. This
reduces false matches without truncating a road that is split across several OSM ways.

## Cache model

| Layer | Key or strategy | Lifetime |
| --- | --- | --- |
| Single-query API response | Hashed `outages:*` key with SWR | 15 minutes fresh; retained for 24 hours |
| Per-commune viewport facts | Hashed `commune-outages:*` key | 15 minutes fresh; retained for 24 hours |
| Raw Enedis single-query index | Shared `enedis:index`, capped at 200 entries | 5 minutes |
| Snapped commune viewport | `communes:*` | 7 days |
| Commune point and contour index | `communes:points`, capped at 2,500 entries | 7 days |
| Geocoding index | `geocode:index` | Persistent KV entry |
| Street geometry index | `streetgeom:streets:*` | 24 hours |

Single-commune API responses can be returned stale while `ctx.waitUntil()` refreshes them in the background.
Viewport responses are rebuilt from fresh per-commune facts instead of storing a large response for every possible
map rectangle.

Empty commune results are stored in a compact form because communes without a current outage are the common case.

## Runtime limits and concurrency

The Worker currently enforces:

- a maximum viewport area of 0.35 square degrees;
- a maximum latitude or longitude span of 1 degree;
- a maximum of 30 resolved communes;
- eight concurrent commune point lookups;
- six concurrent Enedis commune requests;
- four concurrent street geocoding requests.

These limits protect the upstream services and keep a single map interaction within a predictable amount of work.

## Data semantics

- **HTA** is medium-voltage distribution. An HTA incident can cover a relatively large area.
- **BT** is low-voltage distribution and is usually more local.
- Some Enedis address rows are technical labels rather than real streets. They remain in the list even when no
  reliable geometry can be found.
- Enedis operates at commune scope. A viewport crossing Paris can therefore return every current Paris outage, not
  only streets strictly contained inside the visible rectangle.
