# Operations guide

## Production endpoints

- Primary: [https://enedis.stanislas.cloud](https://enedis.stanislas.cloud)
- Direct `workers.dev` and version preview URLs: disabled
- Legacy Railway URL: `https://enedis-carte-coupure.up.railway.app`

The primary hostname is a Cloudflare Workers Custom Domain. Cloudflare manages its DNS record and TLS
certificate from the route declared in `wrangler.jsonc`.

## Deploying the Worker

Authenticate Wrangler once:

```sh
bunx wrangler login
```

Run tests, build, and deploy:

```sh
bun run test
bun run build
bun run deploy
```

The deploy script rebuilds the project and publishes the generated configuration at
`web/enedis_carte_coupure/wrangler.json`. Production requires the `TURNSTILE_SECRET_KEY`,
`SESSION_SIGNING_SECRET`, and `CURSOR_SIGNING_SECRET` Worker secrets. Never reuse the session and cursor signing
values.

The Worker deployment includes:

- the API entrypoint in `worker/index.ts`;
- the React build as Workers Static Assets;
- the `CACHE` Workers KV binding;
- the `UPSTREAM_COORDINATOR` SQLite Durable Object;
- the `API_RATE_LIMITER` binding at 60 requests per minute per verified session;
- the managed pre-clearance Turnstile widget for `enedis.stanislas.cloud`;
- the `enedis.stanislas.cloud` Custom Domain;
- sampled Workers observability and application traces.

`workers_dev` and preview URLs are disabled. Cloudflare WAF rate limiting is not configured.

Useful smoke checks:

```sh
curl -fsS https://enedis.stanislas.cloud/api/health
curl -fsS https://enedis.stanislas.cloud/api/session
curl -sS -o /dev/null -w '%{http_code}\n' \
  'https://enedis.stanislas.cloud/api/outages?south=48.85&west=2.34&north=48.86&east=2.35'
curl -I https://enedis.stanislas.cloud/
```

The unauthenticated outage request should return `401`. Full outage smoke testing requires completing the
Turnstile widget in a browser; do not automate around the challenge.

## Legacy Railway redirect

Railway no longer runs the application. Its generated hostname is retained so old links and API URLs continue to
work.

The root `Dockerfile` compiles `railway-redirect/server.ts` and packages the generated JavaScript service, which:

- listens on Railway's `PORT`;
- returns `200` from `/healthz` for the deployment healthcheck;
- returns an uncached `307` for every other request;
- preserves the original path and query string;
- always redirects to a fixed target host to avoid open redirects.

The default target is `https://enedis.stanislas.cloud`. It can be overridden with `REDIRECT_TARGET` if a future
domain migration requires it.

Redis is not used by the redirect or Worker. If the old Railway deployment is being retained for a rollback
window, its Redis service can be removed after that window closes.

## Rollback

### Worker rollback

List recent Worker deployments:

```sh
bunx wrangler deployments list --name enedis-carte-coupure
```

Roll back to a known-good Worker version:

```sh
bunx wrangler rollback <version-id> --name enedis-carte-coupure
```

Confirm the primary domain and both API endpoints after the rollback. The Custom Domain is attached to the Worker,
so it continues to route to the active version.

### Railway rollback window

During the migration window, the previous Railway application deployment can be restored from Railway deployment
history. Keep the redirect temporary (`307`) while that rollback path matters; a permanent redirect can be cached
by clients and makes application rollback less predictable.

## Cache behavior

The API exposes its application-level cache state through headers:

- `X-App-Cache: COMMUNE` for fixed viewport pages composed from commune facts;
- `X-App-Cache-Commune-Hits`, `X-App-Cache-Commune-Stale`, and `X-App-Cache-Commune-Misses` for the
  per-commune breakdown of viewport responses;
- `X-App-Cache-Refreshed-At` and `X-App-Cache-Fresh-Until` for cached response timing;
- `X-App-Cache-Refresh: background` when stale data triggered a refresh.

KV is eventually consistent. A recently written entry may not be visible at every edge location immediately, so
occasional repeated upstream work after a cold deployment is expected.

## Tracing

Workers observability is sampled in `wrangler.jsonc`. Provider and cache adapters retain named Effect operations:

- `cache.get` and `cache.put`
- `communes.lookup`
- `enedis.fetch`
- `geocode.lookup`
- `streetgeom.lookup`

Useful bounded attributes include provider names, commune coordinates, street-name batch sizes, cache keys, and
`http.response.status_code`. Cloudflare also creates platform spans for Durable Object calls, outgoing `fetch`, and KV operations.

Higher-level workflows remain named with `Effect.fn`, which improves Effect traces and failure stacks without
creating an extra native span for every pure transformation. Unexpected causes are logged once at the Worker
boundary; public decode errors do not expose Schema diagnostics.

## Troubleshooting

### A cold or broad viewport is slow

Inspect the `enedis.fetch`, `geocode.lookup`, and `streetgeom.lookup` operations. A cold page can wait on several
commune requests even though concurrency is capped. Check `X-App-Cache-Commune-*` and page warnings before
changing coordinator budgets.

### Nearby viewports repeat commune lookups

Check whether the bounds snap to the same `communes:*` cache key. The browser can reuse commune contours within
its current response, while the Worker reuses snapped viewport entries. KV eventual consistency can still cause
brief repeated work after a cold write.

### Street lines are missing

Separate geocoding misses from geometry misses in the response statistics. Then inspect `geocode.lookup`,
`streetgeom.requests`, and `streetgeom.lookup` spans. A technical Enedis label may legitimately have no matching
street geometry.

### The Railway URL does not redirect

Check the active Railway deployment, verify `/healthz` returns `200`, and inspect the `Location` header without
following it:

```sh
curl -sS -D - -o /dev/null https://enedis-carte-coupure.up.railway.app/api/health
```

The expected status is `307` and the location should be the same path on `https://enedis.stanislas.cloud`.
