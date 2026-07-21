# Development guide

## Requirements

- Bun 1.3.9
- Wrangler authentication for deployments

Local development runs entirely through the Cloudflare Vite plugin. A separate Go server or Redis process is not
required.

## Install and run

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bun run dev
```

The shown site and secret keys are Cloudflare's official always-pass test keys. Never deploy them. Open
[http://127.0.0.1:5173](http://127.0.0.1:5173).

The Vite plugin starts the React frontend and Worker together in `workerd`. KV and the
`UPSTREAM_COORDINATOR` Durable Object use local state under `.wrangler/state`.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the local Worker and Vite development server |
| `bun run test` | Run Worker, frontend, and Railway redirect tests with Vitest |
| `bun run typecheck` | Type-check the frontend, Worker, tests, and tooling |
| `bun run build` | Test, type-check, and build the Worker bundle and static assets |
| `bun run build:redirect` | Compile the Railway redirect service to JavaScript |
| `bun run preview` | Preview the production Vite build locally |
| `bun run deploy` | Build and deploy with Wrangler |
| `make dev` | Makefile wrapper around the development server |
| `make test` | Makefile wrapper around the test suite |
| `make clean` | Remove generated build output and local Wrangler state |

## Configuration

The committed defaults live in `wrangler.jsonc`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CACHE_PREFIX` | `enedis-carte-coupure` | Prefix applied to every KV key |
| `COMMUNES_CACHE_TTL` | `7d` | Lifetime of snapped commune viewport entries |
| `OUTAGE_CACHE_TTL` | `15m` | Fresh lifetime of normalized outage data |
| `OUTAGE_CACHE_STALE_TTL` | `7d` | Retention window for stale outage data |
| `APP_ENV` | `production` | Enables strict production secret, action, and hostname validation |
| `APP_ORIGIN` | production origin | Allowed origin for session creation |
| `TURNSTILE_HOSTNAME` | production hostname | Required Siteverify hostname |
| `TURNSTILE_SITE_KEY` | production widget | Public widget key |
| `SESSION_TTL` | `30m` | Verified application session lifetime |
| `CURSOR_TTL` | `10m` | Maximum pagination-sequence lifetime |

Duration values accept `ms`, `s`, `m`, `h`, or `d`. Invalid values fall back to the defaults in the Worker.

Local development variables belong in `.dev.vars` or `.dev.vars.*`; those files are ignored except for the safe
`.dev.vars.example` template. Do not commit real tokens or secrets.

## Build output

`bun run build` produces two ignored directories under `web/`:

```text
web/client/                     React static assets
web/enedis_carte_coupure/      Worker bundle and generated Wrangler config
```

The deployment script uses the generated Worker configuration because the Cloudflare Vite plugin adds the static
asset directory during the build.

## Tests

Vitest and `@effect/vitest` run in the Node environment and cover:

- typed KV decoding and malformed cache entries;
- upstream JSON/status classification;
- viewport parsing, snapping, containment, and commune geometry;
- signed cursor integrity, session binding, and expiration;
- secure session-cookie handling and upstream token-bucket calculations;
- fixed-page aggregation, street-label normalization, and line merging;
- public API response decoding and HTTP error mapping;
- Worker transport error responses;
- Railway redirect path/query preservation and open-redirect protection.

Run the production build when changing Worker routing, assets, or Wrangler configuration. It runs the complete
test suite and type-check before bundling:

```sh
bun run build
```

## Repository layout

```text
frontend/               React, MapLibre GL, and Effect API client
shared/                 Effect Schema public API contract
worker/                 Effect services, Worker API, and data pipeline
railway-redirect/       Legacy Railway URL redirect service
docs/                   Architecture, API, development, and operations guides
wrangler.jsonc          Worker bindings, variables, routes, and observability
tsconfig.json           Shared TypeScript compiler configuration
tsconfig.redirect.json  Emitting compiler configuration for the Railway service
vite.config.ts          React and Cloudflare Vite integration
vitest.config.ts        Worker and redirect test discovery
Dockerfile              Railway redirect image only
railway.json            Railway deployment and healthcheck settings
web/                    Generated build output; ignored
```

The old Go runtime, Redis client, and checked-in frontend bundle were removed when the application moved to
Cloudflare Workers.

## Working on the data pipeline

The main modules are intentionally separated by responsibility:

- `shared/api.ts` defines the public response schemas consumed by both runtimes.
- `worker/index.ts` is the thin routing, layer assembly, and `Effect.runPromise` boundary.
- `worker/platform.ts` provides configuration, coordinated HTTP, KV, rate-limit, request context, and background-task services.
- `worker/session.ts`, `signing.ts`, and `cursor.ts` own verification, signed sessions, and pagination integrity.
- `worker/upstream-coordinator.ts` enforces global provider budgets, concurrency, coalescing, deadlines, and body limits.
- `worker/service.ts` owns outage caching and fixed viewport-page orchestration.
- `worker/communes.ts`, `enedis.ts`, `geocode.ts`, and `streetgeom.ts` are provider services.
- `worker/streetgeom-overpass.ts` and `streetgeom-geometry.ts` isolate query building and geometry math.
- `worker/outages.ts` owns provider-backed enrichment; `outage-response.ts`, `outage-merging.ts`, `outage-values.ts`, `outage-polygons.ts`, and `street-normalization.ts` contain focused pure transformations.
- `worker/errors.ts` defines the typed failure contract.
- `frontend/src/api/client.ts` performs session and cursor-page requests and validates responses before React sees them.
- `frontend/src/domain/outagePages.ts` merges unique pages into one map response.

See [Architecture and data flow](architecture.md) before changing cache keys or the commune composition model.
