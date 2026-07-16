# Development guide

## Requirements

- Node.js 22 or newer
- npm
- Wrangler authentication for deployments

Local development runs entirely through the Cloudflare Vite plugin. A separate Go server or Redis process is not
required.

## Install and run

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

The Vite plugin starts the React frontend and Worker together in `workerd`. The `CACHE` binding uses local state
under `.wrangler/state`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Worker and Vite development server |
| `npm test` | Run Worker and Railway redirect tests with Vitest |
| `npm run build` | Build the Worker bundle and static assets |
| `npm run preview` | Preview the production Vite build locally |
| `npm run deploy` | Build and deploy with Wrangler |
| `make dev` | Makefile wrapper around the development server |
| `make test` | Makefile wrapper around the test suite |
| `make clean` | Remove generated build output and local Wrangler state |

## Configuration

The committed defaults live in `wrangler.jsonc`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CACHE_PREFIX` | `enedis-carte-coupure` | Prefix applied to every KV key |
| `COMMUNES_CACHE_TTL` | `7d` | Lifetime of commune viewport and point indexes |
| `ENEDIS_CACHE_TTL` | `5m` | Fresh lifetime of raw single-query Enedis data |
| `OUTAGE_CACHE_TTL` | `15m` | Fresh lifetime of normalized outage data |
| `OUTAGE_CACHE_STALE_TTL` | `24h` | Retention window for stale outage data |

Duration values accept `ms`, `s`, `m`, `h`, or `d`. Invalid values fall back to the defaults in the Worker.

Local development variables belong in `.dev.vars` or `.dev.vars.*`; those files are ignored. Do not commit tokens
or secrets.

## Build output

`npm run build` produces two ignored directories under `web/`:

```text
web/client/                     React static assets
web/enedis_carte_coupure/      Worker bundle and generated Wrangler config
```

The deployment script uses the generated Worker configuration because the Cloudflare Vite plugin adds the static
asset directory during the build.

## Tests

Vitest runs in the Node environment and currently covers:

- KV JSON serialization, key prefixing, and expiration;
- deterministic outage cache keys and duration parsing;
- Enedis cache reuse and explicit cache bypass;
- viewport parsing and snapped cache bounds;
- commune contour reuse across shifted viewports;
- street-label normalization;
- Railway redirect path/query preservation and open-redirect protection.

Run the same production build after tests when changing Worker routing, assets, or Wrangler configuration:

```sh
npm test
npm run build
```

## Repository layout

```text
frontend/               React and Leaflet application
worker/                 Worker API and data pipeline
railway-redirect/       Legacy Railway URL redirect service
docs/                   Architecture, API, development, and operations guides
wrangler.jsonc          Worker bindings, variables, routes, and observability
vite.config.js          React and Cloudflare Vite integration
vitest.config.js        Worker and redirect test discovery
Dockerfile              Railway redirect image only
railway.json            Railway deployment and healthcheck settings
web/                    Generated build output; ignored
```

The old Go runtime, Redis client, and checked-in frontend bundle were removed when the application moved to
Cloudflare Workers.

## Working on the data pipeline

The main modules are intentionally separated by responsibility:

- `worker/index.js` owns routing, runtime configuration, response caching, and viewport composition.
- `worker/communes.js` resolves map bounds to communes and maintains the point/contour index.
- `worker/enedis.js` builds and executes Enedis queries.
- `worker/outages.js` normalizes and merges incidents and streets.
- `worker/geocode.js` handles GeoPF and fallback geocoding.
- `worker/streetgeom.js` builds bounded Overpass queries and filters geometry.
- `worker/cache.js` provides the traced KV JSON abstraction.
- `worker/trace.js` wraps Cloudflare application spans.

See [Architecture and data flow](architecture.md) before changing cache keys or the commune composition model.
