package httpserver

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
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
	cacheEntryVersion    = 1
	refreshTimeout       = 3 * time.Minute
	cacheWriteTimeout    = 10 * time.Second
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
	OutageStaleTTL time.Duration
}

func New(config Config) http.Handler {
	mux := http.NewServeMux()
	server := &server{
		config:     config,
		refreshing: map[string]struct{}{},
	}
	mux.HandleFunc("/api/health", server.health)
	mux.HandleFunc("/api/outages", server.outages)
	mux.HandleFunc("/", server.static)
	return mux
}

type server struct {
	config     Config
	refreshMu  sync.Mutex
	refreshing map[string]struct{}
}

type outageCacheEntry struct {
	Version     int              `json:"version"`
	Response    outages.Response `json:"response"`
	RefreshedAt time.Time        `json:"refreshedAt"`
	FreshUntil  time.Time        `json:"freshUntil"`
}

type responseError struct {
	Status   int      `json:"-"`
	Code     string   `json:"error"`
	Message  string   `json:"message"`
	Warnings []string `json:"warnings,omitempty"`
}

func (e *responseError) Error() string {
	return e.Message
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
	refresh := func(ctx context.Context) (outages.Response, error) {
		return s.fetchSingleOutages(ctx, query, includeRaw, shouldGeocode)
	}

	if s.serveCachedOutage(w, r, cacheKey, refresh) {
		return
	}

	response, err := refresh(r.Context())
	if err != nil {
		writeResponseError(w, err, http.StatusBadGateway, "ENEDIS_FETCH_FAILED")
		return
	}

	s.storeOutageCache(r.Context(), cacheKey, response)
	w.Header().Set("X-App-Cache", "MISS")
	writeJSON(w, http.StatusOK, response)
}

func (s *server) fetchSingleOutages(ctx context.Context, query enedis.Query, includeRaw bool, shouldGeocode bool) (outages.Response, error) {
	rawBody, raw, err := s.config.Enedis.Fetch(ctx, query)
	if err != nil {
		return outages.Response{}, err
	}

	response := s.config.Normalizer.Normalize(ctx, raw, query, shouldGeocode)
	if includeRaw {
		response.Raw = rawBody
	}
	if shouldGeocode {
		s.saveGeocodeCaches()
	}
	return response, nil
}

func (s *server) viewportOutages(w http.ResponseWriter, r *http.Request, bounds geo.Bounds) {
	includeRaw := r.URL.Query().Get("raw") == "1"
	shouldGeocode := r.URL.Query().Get("geocode") != "0"

	if bounds.Area() > maxViewportArea || bounds.Height() > maxViewportSpan || bounds.Width() > maxViewportSpan {
		writeResponseError(w, &responseError{
			Status:  http.StatusBadRequest,
			Code:    "VIEWPORT_TOO_LARGE",
			Message: "viewport is too large; zoom in",
		}, http.StatusBadRequest, "VIEWPORT_TOO_LARGE")
		return
	}
	if s.config.Communes == nil {
		writeResponseError(w, &responseError{
			Status:  http.StatusInternalServerError,
			Code:    "COMMUNE_LOOKUP_UNAVAILABLE",
			Message: "commune lookup client is not configured",
		}, http.StatusInternalServerError, "COMMUNE_LOOKUP_UNAVAILABLE")
		return
	}

	cacheKey := viewportOutageCacheKey(bounds, includeRaw, shouldGeocode)
	refresh := func(ctx context.Context) (outages.Response, error) {
		return s.fetchViewportOutages(ctx, bounds, includeRaw, shouldGeocode)
	}

	if s.serveCachedOutage(w, r, cacheKey, refresh) {
		return
	}

	response, err := refresh(r.Context())
	if err != nil {
		writeResponseError(w, err, http.StatusBadGateway, "VIEWPORT_FETCH_FAILED")
		return
	}

	s.storeOutageCache(r.Context(), cacheKey, response)
	w.Header().Set("X-App-Cache", "MISS")
	writeJSON(w, http.StatusOK, response)
}

func (s *server) fetchViewportOutages(ctx context.Context, bounds geo.Bounds, includeRaw bool, shouldGeocode bool) (outages.Response, error) {
	visibleCommunes, err := s.config.Communes.ForBounds(ctx, bounds, maxViewportCommunes)
	if err != nil {
		status := http.StatusBadGateway
		code := "COMMUNE_LOOKUP_FAILED"
		if strings.Contains(err.Error(), "zoom in") {
			status = http.StatusBadRequest
			code = "VIEWPORT_TOO_MANY_COMMUNES"
		}
		return outages.Response{}, &responseError{
			Status:  status,
			Code:    code,
			Message: err.Error(),
		}
	}

	inputs, warnings := s.fetchVisibleCommunes(ctx, visibleCommunes)

	if len(inputs) == 0 && len(warnings) > 0 {
		return outages.Response{}, &responseError{
			Status:   http.StatusBadGateway,
			Code:     "ENEDIS_FETCH_FAILED",
			Message:  "all visible commune requests failed",
			Warnings: warnings,
		}
	}

	response := s.config.Normalizer.NormalizeSet(ctx, inputs, shouldGeocode, &bounds)
	response.Viewport = &bounds
	response.Communes = responseCommunes(visibleCommunes)
	response.Warnings = warnings
	if includeRaw {
		response.Warnings = append(response.Warnings, "raw Enedis payloads are omitted for viewport aggregation")
	}
	if shouldGeocode {
		s.saveGeocodeCaches()
	}
	return response, nil
}

func (s *server) fetchVisibleCommunes(ctx context.Context, visibleCommunes []communes.Commune) ([]outages.Input, []string) {
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
				_, raw, err := s.config.Enedis.Fetch(ctx, query)
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

func (s *server) serveCachedOutage(
	w http.ResponseWriter,
	r *http.Request,
	cacheKey string,
	refresh func(context.Context) (outages.Response, error),
) bool {
	if s.config.OutageCache == nil || s.config.OutageCacheTTL <= 0 {
		return false
	}

	entry, found, err := s.readOutageCache(r.Context(), cacheKey)
	if err != nil {
		log.Printf("read outages cache: %v", err)
		return false
	}
	if !found {
		return false
	}

	now := time.Now()
	if now.Before(entry.FreshUntil) {
		writeCacheHeaders(w, "HIT", entry)
		writeJSON(w, http.StatusOK, entry.Response)
		return true
	}

	writeCacheHeaders(w, "STALE", entry)
	w.Header().Set("X-App-Cache-Refresh", "background")
	s.refreshOutageCache(cacheKey, refresh)
	writeJSON(w, http.StatusOK, entry.Response)
	return true
}

func (s *server) readOutageCache(ctx context.Context, cacheKey string) (outageCacheEntry, bool, error) {
	var entry outageCacheEntry
	found, err := s.config.OutageCache.Get(ctx, cacheKey, &entry)
	if err != nil || !found {
		return outageCacheEntry{}, false, err
	}
	if entry.Version != cacheEntryVersion {
		return outageCacheEntry{}, false, nil
	}
	return entry, true, nil
}

func (s *server) storeOutageCache(ctx context.Context, cacheKey string, response outages.Response) {
	if s.config.OutageCache == nil || s.config.OutageCacheTTL <= 0 {
		return
	}

	now := time.Now()
	entry := outageCacheEntry{
		Version:     cacheEntryVersion,
		Response:    response,
		RefreshedAt: now,
		FreshUntil:  now.Add(s.config.OutageCacheTTL),
	}
	if err := s.config.OutageCache.SetTTL(ctx, cacheKey, entry, s.outageRetentionTTL()); err != nil {
		log.Printf("save outages cache: %v", err)
	}
}

func (s *server) refreshOutageCache(cacheKey string, refresh func(context.Context) (outages.Response, error)) {
	s.refreshMu.Lock()
	if _, ok := s.refreshing[cacheKey]; ok {
		s.refreshMu.Unlock()
		return
	}
	s.refreshing[cacheKey] = struct{}{}
	s.refreshMu.Unlock()

	go func() {
		defer func() {
			s.refreshMu.Lock()
			delete(s.refreshing, cacheKey)
			s.refreshMu.Unlock()
		}()

		ctx, cancel := context.WithTimeout(context.Background(), refreshTimeout)
		defer cancel()

		response, err := refresh(ctx)
		if err != nil {
			log.Printf("refresh outages cache %s: %v", cacheKey, err)
			return
		}
		storeCtx, storeCancel := context.WithTimeout(context.Background(), cacheWriteTimeout)
		defer storeCancel()
		s.storeOutageCache(storeCtx, cacheKey, response)
	}()
}

func (s *server) outageRetentionTTL() time.Duration {
	if s.config.OutageStaleTTL > s.config.OutageCacheTTL {
		return s.config.OutageStaleTTL
	}
	return s.config.OutageCacheTTL
}

func writeCacheHeaders(w http.ResponseWriter, status string, entry outageCacheEntry) {
	w.Header().Set("X-App-Cache", status)
	w.Header().Set("X-App-Cache-Refreshed-At", entry.RefreshedAt.UTC().Format(time.RFC3339))
	w.Header().Set("X-App-Cache-Fresh-Until", entry.FreshUntil.UTC().Format(time.RFC3339))
}

func writeResponseError(w http.ResponseWriter, err error, fallbackStatus int, fallbackCode string) {
	var responseErr *responseError
	if errors.As(err, &responseErr) {
		if responseErr.Status == 0 {
			responseErr.Status = fallbackStatus
		}
		if responseErr.Code == "" {
			responseErr.Code = fallbackCode
		}
		writeJSON(w, responseErr.Status, responseErr)
		return
	}
	writeJSON(w, fallbackStatus, map[string]string{
		"error":   fallbackCode,
		"message": err.Error(),
	})
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
