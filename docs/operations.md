# Operations guide

## Production endpoints

- Primary: [https://enedis.stanislas.cloud](https://enedis.stanislas.cloud)
- Workers fallback: [workers.dev deployment](https://enedis-carte-coupure.angristan.workers.dev)
- Legacy Railway URL: `https://enedis-carte-coupure.up.railway.app`

The primary hostname is a Cloudflare Workers Custom Domain. Cloudflare manages its DNS record and TLS
certificate from the route declared in `wrangler.jsonc`.

## Deploying the Worker

Authenticate Wrangler once:

```sh
npx wrangler login
```

Run tests, build, and deploy:

```sh
npm test
npm run build
npm run deploy
```

The deploy script rebuilds the project and publishes the generated configuration at
`web/enedis_carte_coupure/wrangler.json`.

The Worker deployment includes:

- the API entrypoint in `worker/index.ts`;
- the React build as Workers Static Assets;
- the `CACHE` Workers KV binding;
- the `enedis.stanislas.cloud` Custom Domain;
- the `workers.dev` fallback route;
- Workers observability and application traces.

Useful smoke checks:

```sh
curl -fsS https://enedis.stanislas.cloud/api/health
curl -fsS 'https://enedis.stanislas.cloud/api/outages?geocode=0'
curl -I https://enedis.stanislas.cloud/
```

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
npx wrangler deployments list --name enedis-carte-coupure
```

Roll back to a known-good Worker version:

```sh
npx wrangler rollback <version-id> --name enedis-carte-coupure
```

Confirm the primary domain and both API endpoints after the rollback. The Custom Domain is attached to the Worker,
so it continues to route to the active version.

### Railway rollback window

During the migration window, the previous Railway application deployment can be restored from Railway deployment
history. Keep the redirect temporary (`307`) while that rollback path matters; a permanent redirect can be cached
by clients and makes application rollback less predictable.

## Cache behavior

The API exposes its application-level cache state through headers:

- `X-App-Cache: HIT`, `MISS`, or `STALE` for single-query responses;
- `X-App-Cache: COMMUNE` for viewport responses composed from commune facts;
- `X-App-Cache-Commune-Hits`, `X-App-Cache-Commune-Stale`, and `X-App-Cache-Commune-Misses` for the
  per-commune breakdown of viewport responses;
- `X-App-Cache-Refreshed-At` and `X-App-Cache-Fresh-Until` for cached response timing;
- `X-App-Cache-Refresh: background` when stale data triggered a refresh.

KV is eventually consistent. A recently written entry may not be visible at every edge location immediately, so
occasional repeated upstream work after a cold deployment is expected.

## Tracing

Workers observability is enabled in `wrangler.jsonc`. The application creates spans for:

- `request`
- `cache.get` and `cache.put`
- `communes.for_bounds` and `communes.lookup_point`
- `outages.fetch_visible_commune_facts`
- `enedis.fetch`
- `outages.normalize`
- `outages.geocode_streets`
- `outages.attach_geometry`
- `geocode.lookup`
- `streetgeom.requests` and `streetgeom.lookup`
- `outages.refresh_stale` and `outages.refresh_stale_commune`

Useful attributes include:

- `communes.point_cache_hits`
- `communes.point_contour_hits`
- `communes.point_upstream_fetches`
- `communes.responses`, `communes.warnings`, and `communes.cache_*`
- `cache.hit` and `cache.expiration_ttl`
- `streetgeom.missing` and `streetgeom.results`
- upstream `http.response.status_code`

Cloudflare also adds spans for outgoing `fetch` calls and KV operations.

## Troubleshooting

### A cold or broad viewport is slow

Inspect `outages.fetch_visible_commune_facts` and its child `enedis.fetch` spans. A broad uncached view can wait on
several Enedis commune requests even though concurrency is capped at six. Compare point-cache, contour-hit, and
upstream-fetch attributes before changing concurrency.

### Nearby viewports repeat commune lookups

Check `communes.point_cache_hits`, `communes.point_contour_hits`, and `communes.point_upstream_fetches`. Repeated
upstream fetches can indicate a cold `communes:points` index or a viewport outside the cached contours.

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
