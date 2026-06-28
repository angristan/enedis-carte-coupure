package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	appcache "enedis-carte-coupure/internal/cache"
	"enedis-carte-coupure/internal/enedis"
	"enedis-carte-coupure/internal/geocode"
	"enedis-carte-coupure/internal/httpserver"
	"enedis-carte-coupure/internal/outages"
	"enedis-carte-coupure/internal/streetgeom"
)

func main() {
	addr := flag.String("addr", ":"+envString("PORT", "5177"), "HTTP listen address")
	webDir := flag.String("web-dir", "web", "directory containing static web assets")
	cachePath := flag.String("cache", "cache/geocode.json", "geocoding cache file")
	geometryCachePath := flag.String("geometry-cache", "cache/street-geometry.json", "street geometry cache file")
	redisURL := flag.String("redis-url", envString("REDIS_URL", envString("REDIS_PRIVATE_URL", "")), "Redis URL for cache")
	redisAddr := flag.String("redis-addr", envString("REDIS_ADDR", "localhost:6379"), "Redis address for cache; set empty to disable")
	redisPassword := flag.String("redis-password", envString("REDIS_PASSWORD", ""), "Redis password")
	redisDB := flag.Int("redis-db", envInt("REDIS_DB", 0), "Redis database index")
	redisPrefix := flag.String("redis-prefix", envString("REDIS_PREFIX", "enedis-carte-coupure"), "Redis cache key prefix")
	outageCacheTTL := 5 * time.Minute
	flag.Parse()

	httpClient := &http.Client{Timeout: 80 * time.Second}
	enedisClient := enedis.NewClient(httpClient)

	var geocodeCache appcache.JSONStore
	var geometryCache appcache.JSONStore
	var outageCache appcache.TTLJSONStore
	if *redisURL != "" || *redisAddr != "" {
		redisClient, err := appcache.NewRedisClient(context.Background(), appcache.RedisConfig{
			URL:      *redisURL,
			Addr:     *redisAddr,
			Password: *redisPassword,
			DB:       *redisDB,
		})
		if err != nil {
			log.Printf("redis cache unavailable: %v; falling back to file cache", err)
		} else {
			defer redisClient.Close()
			geocodeCache = appcache.NewRedisJSONStore(redisClient, *redisPrefix+":geocode")
			geometryCache = appcache.NewRedisJSONStore(redisClient, *redisPrefix+":streetgeom")
			outageCache = appcache.NewRedisJSONStore(redisClient, *redisPrefix+":outages")
			log.Printf("cache backend: redis db=%d prefix=%s", *redisDB, *redisPrefix)
		}
	}
	if geocodeCache == nil || geometryCache == nil {
		log.Printf("cache backend: files geocode=%s geometry=%s", *cachePath, *geometryCachePath)
	}
	if outageCache == nil {
		outageCache = appcache.NewMemoryTTLJSONStore()
		log.Printf("outages cache backend: memory ttl=%s", outageCacheTTL)
	} else {
		log.Printf("outages cache backend: redis ttl=%s", outageCacheTTL)
	}

	geocoder := geocode.NewClient(httpClient, *cachePath, geocode.WithCache(geocodeCache))
	geometries := streetgeom.NewClient(httpClient, *geometryCachePath, streetgeom.WithCache(geometryCache))
	normalizer := outages.NewNormalizer(geocoder, geometries)

	server := httpserver.New(httpserver.Config{
		WebDir:         *webDir,
		Enedis:         enedisClient,
		Normalizer:     normalizer,
		Geocoder:       geocoder,
		Geometries:     geometries,
		OutageCache:    outageCache,
		OutageCacheTTL: outageCacheTTL,
	})

	log.Printf("listening on http://localhost%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, httpserver.LogRequests(server)))
}

func envString(name, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	return value
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
