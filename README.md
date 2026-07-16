# Enedis Carte Coupure

Carte des rues actuellement touchees par les coupures remontees par Enedis.

L'interface Enedis affiche bien les incidents, mais sa carte ne rend pas toutes les rues concernees tant qu'on ne selectionne pas une rue precise. Ce projet agrege la reponse publique Enedis, geocode les rues, recupere leur geometrie OpenStreetMap, puis les surligne directement sur une carte Leaflet.

## Fonctionnalites

- Carte interactive des rues touchees dans les communes visibles, Paris au chargement.
- Surlignage des rues completes avec geometries OpenStreetMap.
- Rues cliquables sur la carte, popup et synchronisation avec la liste.
- Couleurs par type d'incident: HTA en rouge, BT en orange.
- Recherche par rue, arrondissement ou type d'incident.
- Vue mobile avec carte et liste en panneau bas.
- Worker Cloudflare pour `/api/outages` et `/api/health`.
- Cache Cloudflare KV stale-while-revalidate pour les coupures, le geocodage et les geometries OSM.
- Spans Cloudflare Workers autour des requetes, caches, normalisation et appels upstream.
- Frontend React/Vite servi par Cloudflare Workers Static Assets.

## Apercu technique

Le navigateur ne peut pas appeler directement l'endpoint Enedis depuis n'importe quelle origine, car Enedis ne renvoie pas d'en-tete CORS adapte. Le Worker sert donc de proxy edge et expose une API plus facile a consommer.

```text
Navigateur
  -> Worker /api/outages
    -> geo.api.gouv.fr pour identifier les communes visibles
    -> Enedis panne-interruption-ajax par commune
    -> IGN / api-adresse.data.gouv.fr pour les points de rues
    -> Overpass / OpenStreetMap pour les lignes de rues
    -> Cloudflare KV pour les caches
```

## Lancer en local

Prerequis:

- Node.js 22+ et npm
- Wrangler connecte au compte Cloudflare

Installer les dependances:

```sh
npm ci
```

Lancer l'app dans le runtime Workers local:

```sh
npm run dev
```

Puis ouvrir [http://127.0.0.1:5173](http://127.0.0.1:5173).

Le plugin Cloudflare pour Vite lance le frontend et le Worker ensemble dans `workerd`. Les donnees KV locales sont stockees sous `.wrangler/state`, ignore par git.

## Configuration

Variables Worker utiles:

```sh
CACHE_PREFIX=enedis-carte-coupure
COMMUNES_CACHE_TTL=7d
ENEDIS_CACHE_TTL=5m
OUTAGE_CACHE_TTL=15m
OUTAGE_CACHE_STALE_TTL=24h
```

Les reponses commune par commune sont fraiches pendant `OUTAGE_CACHE_TTL`, puis conservees jusqu'a `OUTAGE_CACHE_STALE_TTL`. Les caches de geocodage et geometrie sont aussi stockes dans KV avec des prefixes separes.
La liste des communes visibles est cachee plus longtemps, car elle depend seulement de la zone de carte. Les points de resolution commune sont aussi indexes avec leurs contours: une vue de carte decalee peut donc reutiliser les communes deja connues sans refaire les 9 appels `geo.api.gouv.fr`. Les reponses par viewport ne sont pas persistees comme gros blobs: elles sont composees depuis les faits normalises par commune.
Le Worker cache ces faits normalises par commune: coupures, rues, geocodage et geometries OSM sur l'emprise de la commune. Les communes sans coupure sont stockees sous une forme compacte. Cote navigateur, les contours de communes permettent de reutiliser une reponse deja chargee quand la nouvelle vue reste dans les memes communes, meme si les rectangles de carte ne se recouvrent pas strictement.

Le repo est configure avec un binding KV `CACHE` dans `wrangler.jsonc`.

## API

```sh
curl 'http://127.0.0.1:5173/api/health'
curl 'http://127.0.0.1:5173/api/outages'
curl 'http://127.0.0.1:5173/api/outages?geocode=0'
curl 'http://127.0.0.1:5173/api/outages?raw=1'
curl 'http://127.0.0.1:5173/api/outages?south=48.815&west=2.224&north=48.902&east=2.470'
```

Par defaut, la requete cible Paris:

```text
insee=75056&type=municipality&adresse=Paris&CPVille=Paris 75001&name=Paris&city=Paris
```

Les memes parametres peuvent etre passes a `/api/outages` pour tester une autre commune, sous reserve que les donnees Enedis et la geometrie OSM soient disponibles.

Quand `south`, `west`, `north` et `east` sont fournis, le Worker echantillonne la vue, resout les communes avec `geo.api.gouv.fr`, interroge Enedis pour chaque commune visible, puis utilise la bbox de la vue pour l'index OSM. Enedis restant une API a la commune, une vue qui traverse Paris recupere les coupures de Paris, pas uniquement les rues strictement dans le rectangle affiche.

## Deploiement Cloudflare

Le Worker est publie sur [https://enedis.stanislas.cloud](https://enedis.stanislas.cloud). Cloudflare gere le DNS et le certificat TLS via le Custom Domain declare dans `wrangler.jsonc`.

Builder et deployer:

```sh
npm run deploy
```

Le build Vite produit:

- `web/client` pour les assets statiques.
- `web/enedis_carte_coupure` pour le Worker bundle et son `wrangler.json`.

Le script de deploiement appelle Wrangler sur la config generee par Vite:

```sh
wrangler deploy --config web/enedis_carte_coupure/wrangler.json
```

L'ancien domaine Railway reste disponible comme redirecteur temporaire. Le conteneur defini par `Dockerfile` renvoie un `307` vers `https://enedis.stanislas.cloud` en conservant le chemin et la query string; `/healthz` reste local pour le healthcheck Railway.

## Observabilite

`wrangler.jsonc` active `observability.traces.enabled`. Le Worker ajoute des spans nommes notamment:

- `request`
- `cache.get` / `cache.put`
- `outages.fetch_visible_commune_facts`
- `enedis.fetch`
- `communes.for_bounds`
- `geocode.lookup`
- `streetgeom.lookup`
- `outages.normalize`
- `outages.refresh_stale`

Cloudflare ajoute aussi ses spans automatiques pour les fetchs et les operations KV.

## Structure

```text
frontend/              source React/Vite
worker/                Worker API, clients upstream, normalisation et caches KV
railway-redirect/      redirecteur de l'ancien domaine Railway
wrangler.jsonc         configuration Cloudflare Workers
vite.config.js         build frontend + Worker via le plugin Cloudflare
web/                   build genere, ignore par git
```

## Notes donnees

- HTA signifie haute tension A, le reseau moyenne tension. Un incident HTA couvre souvent une zone plus large qu'une seule rue.
- BT signifie basse tension. Un incident BT est souvent plus localise cote distribution finale.
- Certaines lignes Enedis sont des libelles techniques, pas de vraies rues. Elles restent visibles dans la liste meme si aucune geometrie fiable n'est trouvee.
- Le premier chargement peut etre plus long: l'index des rues OSM est construit puis mis en cache. Les chargements suivants repartent des caches KV par commune au lieu de recalculer toute la vue.

## Licence

Code sous licence MIT. Projet experimental non affilie a Enedis. Les fonds et geometries de carte viennent d'OpenStreetMap et sont soumis a l'ODbL.
