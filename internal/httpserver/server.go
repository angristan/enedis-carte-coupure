package httpserver

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	appcache "enedis-carte-coupure/internal/cache"
	"enedis-carte-coupure/internal/communes"
	"enedis-carte-coupure/internal/enedis"
	"enedis-carte-coupure/internal/geo"
	"enedis-carte-coupure/internal/geocode"
	"enedis-carte-coupure/internal/outages"
	"enedis-carte-coupure/internal/streetgeom"
)

const (
	maxViewportArea      = 0.35
	maxViewportSpan      = 1.0
	maxViewportCommunes  = 30
	maxEnedisConcurrency = 6
	viewportCacheGridDeg = 0.01
)

type Config struct {
	WebDir         string
	Enedis         *enedis.Client
	Communes       *communes.Client
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
	bounds, hasBounds, err := geo.ParseBounds(r.URL.Query())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "INVALID_VIEWPORT",
			"message": err.Error(),
		})
		return
	}
	if hasBounds {
		s.viewportOutages(w, r, bounds)
		return
	}

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
		s.saveGeocodeCaches()
	}

	if s.config.OutageCache != nil && s.config.OutageCacheTTL > 0 {
		if err := s.config.OutageCache.SetTTL(r.Context(), cacheKey, response, s.config.OutageCacheTTL); err != nil {
			log.Printf("save outages cache: %v", err)
		}
	}
	w.Header().Set("X-App-Cache", "MISS")
	writeJSON(w, http.StatusOK, response)
}

func (s *server) viewportOutages(w http.ResponseWriter, r *http.Request, bounds geo.Bounds) {
	includeRaw := r.URL.Query().Get("raw") == "1"
	shouldGeocode := r.URL.Query().Get("geocode") != "0"

	if bounds.Area() > maxViewportArea || bounds.Height() > maxViewportSpan || bounds.Width() > maxViewportSpan {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "VIEWPORT_TOO_LARGE",
			"message": "viewport is too large; zoom in",
		})
		return
	}
	if s.config.Communes == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "COMMUNE_LOOKUP_UNAVAILABLE",
			"message": "commune lookup client is not configured",
		})
		return
	}

	cacheKey := viewportOutageCacheKey(bounds, includeRaw, shouldGeocode)
	if s.config.OutageCache != nil && s.config.OutageCacheTTL > 0 {
		var cached outages.Response
		found, err := s.config.OutageCache.Get(r.Context(), cacheKey, &cached)
		if err != nil {
			log.Printf("read viewport outages cache: %v", err)
		} else if found {
			w.Header().Set("X-App-Cache", "HIT")
			writeJSON(w, http.StatusOK, cached)
			return
		}
	}

	visibleCommunes, err := s.config.Communes.ForBounds(r.Context(), bounds, maxViewportCommunes)
	if err != nil {
		status := http.StatusBadGateway
		code := "COMMUNE_LOOKUP_FAILED"
		if strings.Contains(err.Error(), "zoom in") {
			status = http.StatusBadRequest
			code = "VIEWPORT_TOO_MANY_COMMUNES"
		}
		writeJSON(w, status, map[string]string{
			"error":   code,
			"message": err.Error(),
		})
		return
	}

	inputs, warnings := s.fetchVisibleCommunes(r, visibleCommunes)

	if len(inputs) == 0 && len(warnings) > 0 {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":    "ENEDIS_FETCH_FAILED",
			"message":  "all visible commune requests failed",
			"warnings": warnings,
		})
		return
	}

	response := s.config.Normalizer.NormalizeSet(r.Context(), inputs, shouldGeocode, &bounds)
	response.Viewport = &bounds
	response.Communes = responseCommunes(visibleCommunes)
	response.Warnings = warnings
	if includeRaw {
		response.Warnings = append(response.Warnings, "raw Enedis payloads are omitted for viewport aggregation")
	}
	if shouldGeocode {
		s.saveGeocodeCaches()
	}

	if s.config.OutageCache != nil && s.config.OutageCacheTTL > 0 {
		if err := s.config.OutageCache.SetTTL(r.Context(), cacheKey, response, s.config.OutageCacheTTL); err != nil {
			log.Printf("save viewport outages cache: %v", err)
		}
	}
	w.Header().Set("X-App-Cache", "MISS")
	writeJSON(w, http.StatusOK, response)
}

func (s *server) fetchVisibleCommunes(r *http.Request, visibleCommunes []communes.Commune) ([]outages.Input, []string) {
	type fetchResult struct {
		Index   int
		Input   outages.Input
		Warning string
	}

	jobs := make(chan int)
	results := make(chan fetchResult, len(visibleCommunes))
	var wg sync.WaitGroup
	workerCount := min(maxEnedisConcurrency, len(visibleCommunes))
	for range workerCount {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				commune := visibleCommunes[index]
				query := commune.EnedisQuery()
				_, raw, err := s.config.Enedis.Fetch(r.Context(), query)
				if err != nil {
					results <- fetchResult{
						Index:   index,
						Warning: fmt.Sprintf("%s (%s): %v", commune.Name, commune.Code, err),
					}
					continue
				}
				results <- fetchResult{
					Index: index,
					Input: outages.Input{Raw: raw, Query: query},
				}
			}
		}()
	}
	for index := range visibleCommunes {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	close(results)

	ordered := make([]fetchResult, 0, len(visibleCommunes))
	for result := range results {
		ordered = append(ordered, result)
	}
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].Index < ordered[j].Index
	})

	inputs := make([]outages.Input, 0, len(visibleCommunes))
	warnings := []string{}
	for _, result := range ordered {
		if result.Warning != "" {
			warnings = append(warnings, result.Warning)
			continue
		}
		inputs = append(inputs, result.Input)
	}
	return inputs, warnings
}

func outageCacheKey(query enedis.Query, includeRaw bool, shouldGeocode bool) string {
	payload, _ := json.Marshal(struct {
		Kind          string       `json:"kind"`
		Query         enedis.Query `json:"query"`
		IncludeRaw    bool         `json:"includeRaw"`
		ShouldGeocode bool         `json:"shouldGeocode"`
	}{
		Kind:          "single",
		Query:         query,
		IncludeRaw:    includeRaw,
		ShouldGeocode: shouldGeocode,
	})
	sum := sha256.Sum256(payload)
	return fmt.Sprintf("outages:%x", sum)
}

func viewportOutageCacheKey(bounds geo.Bounds, includeRaw bool, shouldGeocode bool) string {
	payload, _ := json.Marshal(struct {
		Kind          string     `json:"kind"`
		Bounds        geo.Bounds `json:"bounds"`
		IncludeRaw    bool       `json:"includeRaw"`
		ShouldGeocode bool       `json:"shouldGeocode"`
	}{
		Kind:          "viewport",
		Bounds:        bounds.Snapped(viewportCacheGridDeg),
		IncludeRaw:    includeRaw,
		ShouldGeocode: shouldGeocode,
	})
	sum := sha256.Sum256(payload)
	return fmt.Sprintf("outages:%x", sum)
}

func (s *server) saveGeocodeCaches() {
	if err := s.config.Geocoder.Save(); err != nil {
		log.Printf("save geocode cache: %v", err)
	}
	if s.config.Geometries != nil {
		if err := s.config.Geometries.Save(); err != nil {
			log.Printf("save street geometry cache: %v", err)
		}
	}
}

func responseCommunes(items []communes.Commune) []outages.Commune {
	response := make([]outages.Commune, 0, len(items))
	for _, item := range items {
		commune := outages.Commune{
			Code:      item.Code,
			Name:      item.Name,
			Postcodes: item.Postcodes,
		}
		if len(item.Center.Coordinates) >= 2 {
			commune.Center = geo.Point{Lat: item.Center.Coordinates[1], Lng: item.Center.Coordinates[0]}
		}
		response = append(response, commune)
	}
	return response
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
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
