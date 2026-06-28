package httpserver

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	appcache "enedis-carte-coupure/internal/cache"
	"enedis-carte-coupure/internal/enedis"
	"enedis-carte-coupure/internal/geocode"
	"enedis-carte-coupure/internal/outages"
	"enedis-carte-coupure/internal/streetgeom"
)

type Config struct {
	WebDir         string
	Enedis         *enedis.Client
	Normalizer     *outages.Normalizer
	Geocoder       *geocode.Client
	Geometries     *streetgeom.Client
	OutageCache    appcache.TTLJSONStore
	OutageCacheTTL time.Duration
}

func New(config Config) http.Handler {
	mux := http.NewServeMux()
	server := &server{config: config}
	mux.HandleFunc("/api/health", server.health)
	mux.HandleFunc("/api/outages", server.outages)
	mux.HandleFunc("/", server.static)
	return mux
}

type server struct {
	config Config
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) outages(w http.ResponseWriter, r *http.Request) {
	query := enedis.QueryFromValues(r.URL.Query())
	includeRaw := r.URL.Query().Get("raw") == "1"
	shouldGeocode := r.URL.Query().Get("geocode") != "0"
	cacheKey := outageCacheKey(query, includeRaw, shouldGeocode)

	if s.config.OutageCache != nil && s.config.OutageCacheTTL > 0 {
		var cached outages.Response
		found, err := s.config.OutageCache.Get(r.Context(), cacheKey, &cached)
		if err != nil {
			log.Printf("read outages cache: %v", err)
		} else if found {
			w.Header().Set("X-App-Cache", "HIT")
			writeJSON(w, http.StatusOK, cached)
			return
		}
	}

	rawBody, raw, err := s.config.Enedis.Fetch(r.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":   "ENEDIS_FETCH_FAILED",
			"message": err.Error(),
		})
		return
	}

	response := s.config.Normalizer.Normalize(r.Context(), raw, query, shouldGeocode)
	if includeRaw {
		response.Raw = rawBody
	}
	if shouldGeocode {
		if err := s.config.Geocoder.Save(); err != nil {
			log.Printf("save geocode cache: %v", err)
		}
		if s.config.Geometries != nil {
			if err := s.config.Geometries.Save(); err != nil {
				log.Printf("save street geometry cache: %v", err)
			}
		}
	}

	if s.config.OutageCache != nil && s.config.OutageCacheTTL > 0 {
		if err := s.config.OutageCache.SetTTL(r.Context(), cacheKey, response, s.config.OutageCacheTTL); err != nil {
			log.Printf("save outages cache: %v", err)
		}
	}
	w.Header().Set("X-App-Cache", "MISS")
	writeJSON(w, http.StatusOK, response)
}

func outageCacheKey(query enedis.Query, includeRaw bool, shouldGeocode bool) string {
	payload, _ := json.Marshal(struct {
		Query         enedis.Query `json:"query"`
		IncludeRaw    bool         `json:"includeRaw"`
		ShouldGeocode bool         `json:"shouldGeocode"`
	}{
		Query:         query,
		IncludeRaw:    includeRaw,
		ShouldGeocode: shouldGeocode,
	})
	sum := sha256.Sum256(payload)
	return fmt.Sprintf("outages:%x", sum)
}

func (s *server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestPath := cleanPath(r.URL.Path)
	if requestPath == "/" {
		requestPath = "/index.html"
	}

	fullPath := filepath.Join(s.config.WebDir, filepath.FromSlash(strings.TrimPrefix(requestPath, "/")))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, fullPath)
}

func LogRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, html.EscapeString(r.URL.RequestURI()), time.Since(start).Round(time.Millisecond))
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func cleanPath(value string) string {
	cleaned := "/" + strings.TrimPrefix(value, "/")
	cleaned = filepath.ToSlash(filepath.Clean(cleaned))
	if cleaned == "/." {
		return "/"
	}
	return cleaned
}
