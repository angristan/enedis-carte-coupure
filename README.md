# Enedis Outage Map

An interactive map of streets currently affected by Enedis power outages in France.

**[Open the live map](https://enedis.stanislas.cloud)**

Enedis publishes useful outage data, but its public map does not draw every affected street at once. This project
collects the public data for the communes visible on the map, normalizes the affected addresses, geocodes the
streets, retrieves their OpenStreetMap geometry, and renders the complete result with MapLibre GL.

## Highlights

- Loads visible communes in signed, fixed pages of six and merges them progressively.
- Requires one managed Turnstile verification and a short-lived signed session.
- Applies per-session rate limits plus global upstream budgets, coalescing, deadlines, and body limits.
- Draws complete affected streets instead of isolated address points.
- Distinguishes HTA incidents, planned HTA work, and BT incidents.
- Keeps the map, street list, filters, and search synchronized.
- Reuses commune contours when the map moves within an area that is already loaded.
- Runs the API and React application together on Cloudflare Workers.
- Uses Effect v4 services, layers, typed errors, cancellation, and bounded concurrency.
- Validates upstream, cache, and public API data with a shared Effect Schema contract.
- Uses Workers KV for outage, commune, geocoding, and street-geometry caches.
- Emits native Cloudflare spans around cache and upstream boundaries.

## How it works

```text
Browser (React + Effect API decoder)
  -> Turnstile -> signed HttpOnly application session
  -> Cloudflare Worker (strict viewport pages + signed cursors + rate limit)
       -> UpstreamCoordinator Durable Object
            -> provider token buckets, concurrency caps, coalescing, deadlines
            -> IGN / Enedis / GeoPF / api-adresse / Overpass
       -> Workers KV caches Schema-validated results and indexes
```

The Worker serves `/api/health`, `/api/session`, `/api/outages`, and the built React application from one deployment. See
[Architecture and data flow](docs/architecture.md) for the complete request and cache model.

## Quick start

Requires [Bun](https://bun.sh/) 1.3.9.

```sh
bun install --frozen-lockfile
cat > .dev.vars <<'EOF'
APP_ENV=development
APP_ORIGIN=http://127.0.0.1:5173
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
SESSION_SIGNING_SECRET=local-session-signing-secret-at-least-32-bytes
CURSOR_SIGNING_SECRET=local-cursor-signing-secret-at-least-32-bytes
EOF
bun run dev
```

`.dev.vars` is ignored by Git. These are Cloudflare's official always-pass test keys and must not be used in
production. Open [http://127.0.0.1:5173](http://127.0.0.1:5173); the Cloudflare Vite plugin runs the frontend and
Worker together in local `workerd`.

Useful commands:

```sh
bun run test
bun run typecheck
bun run build
bun run deploy
```

Wrangler authentication is required for deployment. Local KV state is stored under `.wrangler/state` and is not
committed.

## Documentation

- [Architecture and data flow](docs/architecture.md) — components, upstream services, spatial lookup, caching,
  and browser-side reuse.
- [API reference](docs/api.md) — endpoints, query parameters, response fields, headers, and errors.
- [Development guide](docs/development.md) — local setup, commands, configuration, tests, and repository layout.
- [Operations guide](docs/operations.md) — deployment, domains, the Railway redirect, rollback, observability,
  and troubleshooting.

## Data and attribution

The application uses public outage information from Enedis, French government geocoding and commune APIs, and
OpenStreetMap geometry obtained through Overpass. Map tiles and street geometry are subject to the OpenStreetMap
ODbL.

This is an experimental, unofficial project and is not affiliated with Enedis.

## License

[MIT](LICENSE)
