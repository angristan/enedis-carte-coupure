package httpserver

import (
	"encoding/json"
	"html"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"enedis-carte-coupure/internal/enedis"
	"enedis-carte-coupure/internal/geocode"
	"enedis-carte-coupure/internal/outages"
	"enedis-carte-coupure/internal/streetgeom"
)

type Config struct {
	WebDir     string
	Enedis     *enedis.Client
	Normalizer *outages.Normalizer
	Geocoder   *geocode.Client
	Geometries *streetgeom.Client
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

	writeJSON(w, http.StatusOK, response)
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
