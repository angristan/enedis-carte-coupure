# Enedis Outage Map

An interactive map of streets currently affected by Enedis power outages in France.

**[Open the live map](https://enedis.stanislas.cloud)**

Enedis publishes useful outage data, but its public map does not draw every affected street at once. This project
collects the public data for the communes visible on the map, normalizes the affected addresses, geocodes the
streets, retrieves their OpenStreetMap geometry, and renders the complete result in Leaflet.

## Highlights

- Loads outages for every commune visible in the current viewport.
- Draws complete affected streets instead of isolated address points.
- Distinguishes HTA incidents, planned HTA work, and BT incidents.
- Keeps the map, street list, filters, and search synchronized.
- Reuses commune contours when the map moves within an area that is already loaded.
- Runs the API and React application together on Cloudflare Workers.
- Uses Workers KV for outage, commune, geocoding, and street-geometry caches.
- Emits application spans around cache work, normalization, and upstream requests.

## How it works

```text
Browser
  -> Cloudflare Worker
       -> geo.api.gouv.fr finds the visible communes
       -> Enedis provides outage data for each commune
       -> GeoPF / api-adresse geocodes affected streets
       -> Overpass provides OpenStreetMap street geometry
       -> Workers KV caches reusable results and indexes
```

The Worker serves `/api/health`, `/api/outages`, and the built React application from one deployment. See
[Architecture and data flow](docs/architecture.md) for the complete request and cache model.

## Quick start

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The Cloudflare Vite plugin runs the frontend and Worker
together in the local `workerd` runtime.

Useful commands:

```sh
npm test
npm run build
npm run deploy
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
