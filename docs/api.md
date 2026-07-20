# API reference

The public API is available at `https://enedis.stanislas.cloud`. Local development uses
`http://127.0.0.1:5173`.

All JSON responses use `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`. The response
contract is defined once in `shared/api.ts`: the Worker encodes it and the browser decodes it with Effect Schema.
Workers KV still caches application data internally; `no-store` prevents browsers and intermediate HTTP caches
from hiding the application's freshness semantics.

## `GET /api/health`

Returns a lightweight liveness response:

```json
{"ok":true}
```

Example:

```sh
curl https://enedis.stanislas.cloud/api/health
```

## `GET /api/outages`

Returns normalized outages and affected streets. `HEAD` is also accepted.

Without viewport parameters, the endpoint uses the default Paris query:

```text
insee=75056
type=municipality
adresse=Paris
CPVille=Paris 75001
name=Paris
city=Paris
```

```sh
curl 'https://enedis.stanislas.cloud/api/outages'
```

### Viewport mode

Pass all four bounds:

```sh
curl 'https://enedis.stanislas.cloud/api/outages?south=48.815&west=2.224&north=48.902&east=2.470'
```

The equivalent `bbox` form uses `west,south,east,north` order:

```sh
curl 'https://enedis.stanislas.cloud/api/outages?bbox=2.224,48.815,2.470,48.902'
```

Viewport requests resolve every commune whose contour intersects the visible bounds and compose their normalized
results. A viewport is rejected when it exceeds the configured area/span limits or resolves to more than 200
communes.

### Query parameters

| Parameter | Meaning |
| --- | --- |
| `south`, `west`, `north`, `east` | Viewport bounds; all four are required together |
| `bbox` | Alternative viewport in `west,south,east,north` order |
| `communeLimit` | In viewport mode, load only the nearest N communes for progressive rendering |
| `insee` | Commune INSEE code for single-query mode |
| `type` | Enedis location type, normally `municipality` |
| `adresse` | Address or commune label sent to Enedis |
| `CPVille` | Postal code and city label sent to Enedis |
| `name` | Commune name sent to Enedis |
| `district` | Optional district value |
| `city` | City used when normalizing street labels |
| `longitude` or `long` | Optional longitude sent to the Enedis result-page context |
| `latitude` or `lat` | Optional latitude sent to the Enedis result-page context |
| `department` or `departement` | Optional department code |
| `geocode=0` | Skip street geocoding and OSM geometry |
| `raw=1` | Include the raw Enedis payload in single-query mode |

Raw payloads are intentionally omitted from composed viewport responses; the response includes a warning when
`raw=1` is requested in viewport mode.

### Response shape

The response includes:

| Field | Description |
| --- | --- |
| `updatedAt` | Time at which the normalized response was produced |
| `source` | Upstream endpoint metadata |
| `query` | Primary Enedis query |
| `queries` | All Enedis queries when several communes were composed |
| `viewport` | Requested bounds in viewport mode |
| `communes` | Loaded commune names, codes, centers, and contours |
| `communeTotal` | Total number of communes intersecting the viewport before `communeLimit` |
| `polygon` | Enedis outage polygons, possibly combined as a feature collection |
| `stats` | Incident, street, geocoding, geometry, and Enedis counters |
| `outages` | Normalized incident records |
| `streets` | Deduplicated affected streets with geocoding and geometry results |
| `warnings` | Per-commune failures or non-fatal behavior notes |
| `recap`, `crises` | Additional Enedis summary data when present |
| `raw` | Raw Enedis payload in single-query mode when requested |

Street records retain their display label, normalized name, city, postcode, incident types, dates, affected-home
count, geocoding result, and OSM line geometry.

### Cache headers

The Worker reports application cache behavior without exposing it in the UI:

| Header | Meaning |
| --- | --- |
| `X-App-Cache: HIT` | A fresh single-query response was served from KV |
| `X-App-Cache: MISS` | The response was fetched and stored |
| `X-App-Cache: STALE` | A retained response was served while a background refresh started |
| `X-App-Cache: COMMUNE` | A viewport response was composed from per-commune facts |
| `X-App-Cache-Commune-Hits` | Number of communes served from fresh cache entries |
| `X-App-Cache-Commune-Stale` | Number of communes served stale while refreshing in the background |
| `X-App-Cache-Commune-Misses` | Number of communes fetched synchronously, including failed fetches |
| `X-App-Cache-Refreshed-At` | Time the cached response was produced |
| `X-App-Cache-Fresh-Until` | End of the response's fresh period |
| `X-App-Cache-Refresh: background` | A stale response triggered background refresh work |

### Errors

Errors use this shape:

```json
{
  "error": "INVALID_VIEWPORT",
  "message": "missing north"
}
```

Common statuses:

| Status | Code or condition |
| --- | --- |
| `400` | Invalid, partial, or oversized viewport |
| `405` | Method other than `GET` or `HEAD` on `/api/outages` |
| `502` | Every required commune failed, an upstream rejected the request, or an upstream payload was invalid |
| `500` | Cache-key generation or an unexpected Worker defect failed |

Typed upstream failures use `UPSTREAM_TRANSPORT_ERROR`, `UPSTREAM_STATUS_ERROR`, or `UPSTREAM_DECODE_ERROR`.
Decode responses intentionally omit raw Schema diagnostics.

When only some commune requests fail, the API returns `200` with successful results and records the failures in
`warnings`.
