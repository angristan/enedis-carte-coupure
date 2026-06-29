# Enedis Carte Coupure

Carte locale des rues actuellement touchées par les coupures remontées par Enedis.

L’interface Enedis affiche bien les incidents, mais sa carte ne rend pas toutes les rues concernées tant qu’on ne sélectionne pas une rue précise. Ce projet agrège la réponse publique Enedis, géocode les rues, récupère leur géométrie OpenStreetMap, puis les surligne directement sur une carte Leaflet.

## Fonctionnalités

- Carte interactive des rues touchées dans les communes visibles, Paris au chargement.
- Surlignage des rues complètes avec géométries OpenStreetMap.
- Rues cliquables sur la carte, popup et synchronisation avec la liste.
- Couleurs par type d’incident: HTA en rouge, BT en orange.
- Recherche par rue, arrondissement ou type d’incident.
- Vue mobile avec carte et liste en panneau bas.
- Cache Redis stale-while-revalidate pour `/api/outages`, plus caches géocodage et index OSM.
- Fallback fichier local si Redis n’est pas disponible.
- Backend Go sans framework, frontend HTML/CSS/JS simple.
- Image Docker multi-stage pour le déploiement.

## Aperçu technique

Le navigateur ne peut pas appeler directement l’endpoint Enedis depuis `localhost`, car Enedis ne renvoie pas d’en-tête CORS pour une origine locale. Le serveur Go sert donc de proxy local et expose une API plus facile à consommer.

```text
Navigateur
  -> Go /api/outages
    -> geo.api.gouv.fr pour identifier les communes visibles
    -> Enedis panne-interruption-ajax par commune
    -> IGN / api-adresse.data.gouv.fr pour les points de rues
    -> Overpass / OpenStreetMap pour les lignes de rues
    -> Redis pour les caches
```

## Lancer en local

Prérequis:

- Go 1.22+
- Redis, optionnel mais recommandé

Dans un terminal:

```sh
make redis
```

Dans un autre:

```sh
make run
```

Puis ouvrir [http://localhost:5177](http://localhost:5177).

Sans Redis, l’application continue de fonctionner et écrit les caches dans `cache/*.json`.

## Configuration

Variables utiles:

```sh
PORT=5177
REDIS_URL=redis://localhost:6379
REDIS_ADDR=localhost:6379
REDIS_DB=0
REDIS_PREFIX=enedis-carte-coupure
OUTAGE_CACHE_TTL=5m
OUTAGE_CACHE_STALE_TTL=6h
```

`REDIS_URL` ou `REDIS_PRIVATE_URL` sont prioritaires quand ils existent, ce qui permet un déploiement Railway avec un service Redis attaché. `REDIS_ADDR` reste pratique en local. Les réponses `/api/outages` sont fraîches pendant `OUTAGE_CACHE_TTL`, puis restent servies immédiatement jusqu’à `OUTAGE_CACHE_STALE_TTL` pendant qu’un rafraîchissement se lance en arrière-plan. Les caches géocodage et géométrie restent plus durables.

## API

```sh
curl 'http://localhost:5177/api/health'
curl 'http://localhost:5177/api/outages'
curl 'http://localhost:5177/api/outages?geocode=0'
curl 'http://localhost:5177/api/outages?raw=1'
curl 'http://localhost:5177/api/outages?south=48.815&west=2.224&north=48.902&east=2.470'
```

Par défaut, la requête cible Paris:

```text
insee=75056&type=municipality&adresse=Paris&CPVille=Paris 75001&name=Paris&city=Paris
```

Les mêmes paramètres peuvent être passés à `/api/outages` pour tester une autre commune, sous réserve que les données Enedis et la géométrie OSM soient disponibles.

Quand `south`, `west`, `north` et `east` sont fournis, le serveur échantillonne la vue, résout les communes avec `geo.api.gouv.fr`, interroge Enedis pour chaque commune visible, puis utilise la bbox de la vue pour l’index OSM. Enedis restant une API à la commune, une vue qui traverse Paris récupère les coupures de Paris, pas uniquement les rues strictement dans le rectangle affiché.

## Déploiement Railway

Le repo contient:

- `Dockerfile` pour builder et lancer le serveur Go.
- `railway.json` pour le healthcheck `/api/health`.

Exemple:

```sh
railway init
railway add redis
railway up
```

Railway fournit `PORT` au service web et `REDIS_URL` au service Redis. Le serveur les lit automatiquement.

## Structure

```text
cmd/server              point d’entrée HTTP
Dockerfile              image Go/Alpine pour Railway ou Docker
internal/cache          cache JSON Redis
internal/enedis         client API Enedis
internal/geocode        géocodeur avec cache Redis/fichier
internal/httpserver     routes HTTP et fichiers statiques
internal/outages        normalisation et déduplication des rues
internal/streetgeom     géométrie des rues OSM avec cache Redis/fichier
web/                    frontend Leaflet
cache/                  caches locaux ignorés par git
```

## Notes données

- HTA signifie haute tension A, le réseau moyenne tension. Un incident HTA couvre souvent une zone plus large qu’une seule rue.
- BT signifie basse tension. Un incident BT est souvent plus localisé côté distribution finale.
- Certaines lignes Enedis sont des libellés techniques, pas de vraies rues. Elles restent visibles dans la liste même si aucune géométrie fiable n’est trouvée.
- Le premier chargement peut être plus long: l’index des rues OSM est construit puis mis en cache. Les chargements suivants repartent de Redis ou du cache fichier, et la réponse `/api/outages` est réutilisée pendant 5 minutes.

## Licence

Code sous licence MIT. Projet expérimental non affilié à Enedis. Les fonds et géométries de carte viennent d’OpenStreetMap et sont soumis à l’ODbL.
