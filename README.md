# Enedis

**A live, street-level view of power outages in France.**

[Open the live map →](https://enedis.stanislas.cloud)

> **International context:** Enedis operates most of the public electricity distribution network in mainland
> France. The application uses French network terminology: **HTA** means medium voltage and **BT** means low
> voltage. The interface is in French because the service covers French outage data; the project documentation is
> in English.

## Why this exists

Enedis publishes current outage information, but affected locations are primarily presented as address labels and
are not always easy to understand spatially. This project turns those public reports into an interactive map:

1. Find the communes intersecting the visible map area.
2. Retrieve their current Enedis outage reports.
3. Normalize and deduplicate the affected street names.
4. Geocode those streets and match them to OpenStreetMap geometry.
5. Draw the complete affected street segments with MapLibre GL.

The result is a fast way to answer a simple question: **which streets around me are currently reported as
affected?**

## Features

- **Street-level visualization** rather than isolated address markers.
- **Viewport-based loading** for every commune visible on the map.
- **Progressive results** so useful data appears before the entire area finishes loading.
- **Incident categories** for HTA incidents, planned HTA work, and BT incidents.
- **Search and filters** synchronized with map selection and street details.
- **Mobile-first navigation** with a full-screen map and collapsible results sheet.
- **Resilient caching** that can serve retained data when an upstream service is temporarily unavailable.

## How it works

```text
React + MapLibre browser application
              │
              │ visible bounds + signed page cursor
              ▼
      Cloudflare Worker API
              │
              ├── IGN API Carto ───────── commune boundaries
              ├── Enedis ──────────────── outage reports
              ├── GeoPF / API Adresse ─── street geocoding
              └── Overpass ────────────── OpenStreetMap geometry
                      │
                      ▼
             Workers KV cache

External requests pass through provider-specific Durable Objects for
rate budgets, concurrency limits, request coalescing, and timeouts.
```

The public API only accepts bounded map viewports and returns at most six communes per signed page. Visitors
complete one managed Turnstile check, then use a short-lived signed session for progressive requests. This limits
scraping and protects both upstream services and operating costs without placing a challenge in front of every
page request.

For the complete design, see [Architecture and data flow](docs/architecture.md).

## Technology

| Area | Technology |
| --- | --- |
| Interface | React 19, MapLibre GL, react-map-gl |
| Typed application logic | Effect 4 and Effect Schema |
| Runtime | Cloudflare Workers |
| Coordination | SQLite-backed Durable Objects |
| Cache | Workers KV |
| Build and local runtime | Vite, Cloudflare Vite plugin, Bun |
| Map data | OpenStreetMap and OpenFreeMap |

## Run locally

Requires [Bun](https://bun.sh/) 1.3.9.

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bun run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The example environment uses Cloudflare's official test-only
Turnstile keys; never use them in production. Local KV and Durable Object state are stored under `.wrangler/`.

### Useful commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the frontend and Worker in local `workerd` |
| `bun run test` | Run the complete Vitest suite |
| `bun run typecheck` | Type-check frontend, Worker, and tests |
| `bun run build` | Test, type-check, and build production assets |
| `bun run deploy` | Build and deploy with Wrangler |

Deployment requires Wrangler authentication and the Cloudflare resources described in the
[operations guide](docs/operations.md).

## Documentation

- [Architecture and data flow](docs/architecture.md) — services, request flow, caching, and upstream coordination.
- [API reference](docs/api.md) — sessions, viewport pagination, response fields, headers, and errors.
- [Development guide](docs/development.md) — local setup, configuration, tests, and repository structure.
- [Operations guide](docs/operations.md) — deployment, rollback, observability, and troubleshooting.

## Data sources and attribution

- **Enedis** — public outage reports.
- **IGN API Carto** — French commune boundaries.
- **GeoPF and API Adresse** — French address and street geocoding.
- **OpenStreetMap via Overpass** — street geometry.
- **OpenFreeMap** — base-map tiles and style.

OpenStreetMap data is available under the [ODbL](https://www.openstreetmap.org/copyright). Individual upstream
services remain subject to their own terms and availability.

## Disclaimer

This is an experimental, unofficial project. It is not affiliated with or endorsed by Enedis and must not be used
as an emergency or authoritative network-status service.

## License

[MIT](LICENSE)
