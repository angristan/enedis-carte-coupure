package streetgeom

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"enedis-carte-coupure/internal/cache"
)

const (
	PrimaryEndpoint  = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
	FallbackEndpoint = "https://lz4.overpass-api.de/api/interpreter"
	ParisBBox        = "48.815,2.224,48.902,2.470"
)

type Client struct {
	httpClient  *http.Client
	cachePath   string
	cacheStore  cache.JSONStore
	cache       map[string]Result
	source      string
	updatedAt   string
	loadedRedis bool
	mu          sync.Mutex
	dirty       bool
}

type Point struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type Result struct {
	Status    string    `json:"status"`
	Query     string    `json:"query,omitempty"`
	Source    string    `json:"source,omitempty"`
	OSMNames  []string  `json:"osmNames,omitempty"`
	Lines     [][]Point `json:"lines,omitempty"`
	Message   string    `json:"message,omitempty"`
	UpdatedAt string    `json:"updatedAt,omitempty"`
}

type cacheFile struct {
	UpdatedAt string            `json:"updatedAt"`
	Source    string            `json:"source"`
	Streets   map[string]Result `json:"streets"`
}

type overpassResponse struct {
	Elements []struct {
		Type     string `json:"type"`
		ID       int64  `json:"id"`
		Tags     map[string]string
		Geometry []struct {
			Lat float64 `json:"lat"`
			Lon float64 `json:"lon"`
		} `json:"geometry"`
	} `json:"elements"`
}

type Option func(*Client)

func WithCache(store cache.JSONStore) Option {
	return func(client *Client) {
		client.cacheStore = store
	}
}

func NewClient(httpClient *http.Client, cachePath string, options ...Option) *Client {
	client := &Client{
		httpClient: httpClient,
		cachePath:  cachePath,
		cache:      map[string]Result{},
	}
	for _, option := range options {
		option(client)
	}
	client.load()
	if client.cacheStore != nil && len(client.cache) > 0 {
		client.dirty = true
	}
	return client
}

func (c *Client) Streets(ctx context.Context, names []string) map[string]Result {
	requested := requestedNames(names)
	if len(requested) == 0 {
		return map[string]Result{}
	}

	c.mu.Lock()
	missing := missingKeys(c.cache, requested)
	c.mu.Unlock()

	if len(missing) > 0 && c.cacheStore != nil {
		_ = c.loadRedis(ctx)
		c.mu.Lock()
		missing = missingKeys(c.cache, requested)
		c.mu.Unlock()
	}

	if len(missing) > 0 {
		if err := c.refresh(ctx); err != nil {
			results := map[string]Result{}
			for key, name := range requested {
				results[key] = Result{Status: "error", Query: name, Message: err.Error()}
			}
			return results
		}
	}

	results := map[string]Result{}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, name := range requested {
		result, ok := c.cache[key]
		if !ok {
			result = Result{
				Status:    "miss",
				Query:     name,
				UpdatedAt: c.updatedAt,
			}
			c.cache[key] = result
			c.dirty = true
		}
		result.Query = name
		results[key] = result
	}
	return results
}

func (c *Client) Save() error {
	if c.cacheStore != nil {
		return c.saveRedis()
	}

	c.mu.Lock()
	if !c.dirty {
		c.mu.Unlock()
		return nil
	}
	payload := cacheFile{
		UpdatedAt: c.updatedAt,
		Source:    c.source,
		Streets:   c.cache,
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		c.mu.Unlock()
		return err
	}
	c.dirty = false
	c.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(c.cachePath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(c.cachePath, append(data, '\n'), 0o644)
}

func (c *Client) saveRedis() error {
	c.mu.Lock()
	if !c.dirty {
		c.mu.Unlock()
		return nil
	}
	payload := cacheFile{
		UpdatedAt: c.updatedAt,
		Source:    c.source,
		Streets:   c.cache,
	}
	c.dirty = false
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := c.cacheStore.Set(ctx, "paris", payload); err != nil {
		c.mu.Lock()
		c.dirty = true
		c.mu.Unlock()
		return err
	}
	return nil
}

func (c *Client) refresh(ctx context.Context) error {
	grouped, source, err := c.fetchParis(ctx)
	if err != nil {
		return err
	}

	now := time.Now().Format(time.RFC3339)
	for key, result := range grouped {
		result.UpdatedAt = now
		grouped[key] = result
	}

	c.mu.Lock()
	c.cache = grouped
	c.source = source
	c.updatedAt = now
	c.dirty = true
	c.mu.Unlock()
	return nil
}

func (c *Client) fetchParis(ctx context.Context) (map[string]Result, string, error) {
	var lastErr error
	for _, endpoint := range []string{PrimaryEndpoint, FallbackEndpoint} {
		grouped, err := c.lookup(ctx, endpoint)
		if err == nil {
			return grouped, endpoint, nil
		}
		lastErr = err
	}
	return nil, "", lastErr
}

func (c *Client) lookup(ctx context.Context, endpoint string) (map[string]Result, error) {
	query := fmt.Sprintf(`[out:json][timeout:45];way["highway"]["name"](%s);out tags geom;`, ParisBBox)
	form := url.Values{}
	form.Set("data", query)

	reqCtx, cancel := context.WithTimeout(ctx, 65*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "enedis-carte-coupure/1.0")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s returned %s", endpoint, resp.Status)
	}

	var decoded overpassResponse
	body := io.LimitReader(resp.Body, 96<<20)
	if err := json.NewDecoder(body).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("decode %s: %w", endpoint, err)
	}

	grouped := map[string]Result{}
	for _, element := range decoded.Elements {
		if element.Type != "way" || len(element.Geometry) < 2 {
			continue
		}
		name := strings.TrimSpace(element.Tags["name"])
		if name == "" {
			continue
		}
		key := Key(name)
		if key == "" {
			continue
		}
		line := make([]Point, 0, len(element.Geometry))
		for _, point := range element.Geometry {
			line = append(line, Point{Lat: point.Lat, Lng: point.Lon})
		}
		result := grouped[key]
		if result.Status == "" {
			result.Status = "ok"
			result.Source = endpoint
		}
		addUnique(&result.OSMNames, name)
		result.Lines = append(result.Lines, line)
		grouped[key] = result
	}

	for key, result := range grouped {
		sort.Strings(result.OSMNames)
		grouped[key] = result
	}
	return grouped, nil
}

func (c *Client) load() {
	data, err := os.ReadFile(c.cachePath)
	if err != nil {
		return
	}

	var payload cacheFile
	if err := json.Unmarshal(data, &payload); err == nil && payload.Streets != nil {
		c.cache = payload.Streets
		c.source = payload.Source
		c.updatedAt = payload.UpdatedAt
		return
	}

	legacy := map[string]Result{}
	if err := json.Unmarshal(data, &legacy); err == nil {
		c.cache = legacy
	}
}

func (c *Client) loadRedis(ctx context.Context) error {
	c.mu.Lock()
	if c.loadedRedis {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	var payload cacheFile
	loadCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	found, err := c.cacheStore.Get(loadCtx, "paris", &payload)
	if err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.loadedRedis = true
	if !found || payload.Streets == nil {
		return nil
	}
	c.cache = payload.Streets
	c.source = payload.Source
	c.updatedAt = payload.UpdatedAt
	c.dirty = false
	return nil
}

func requestedNames(names []string) map[string]string {
	requested := map[string]string{}
	for _, name := range names {
		cleaned := strings.TrimSpace(name)
		key := Key(cleaned)
		if key == "" {
			continue
		}
		requested[key] = cleaned
	}
	return requested
}

func missingKeys(cache map[string]Result, requested map[string]string) []string {
	missing := []string{}
	for key := range requested {
		if _, ok := cache[key]; !ok {
			missing = append(missing, key)
		}
	}
	return missing
}

func Key(value string) string {
	value = strings.ToUpper(stripAccents(value))
	value = strings.ReplaceAll(value, "\u00a0", " ")
	value = strings.NewReplacer(
		"-", " ",
		"'", " ",
		"’", " ",
		".", " ",
		"/", " ",
		"(", " ",
		")", " ",
	).Replace(value)
	value = regexp.MustCompile(`[^A-Z0-9]+`).ReplaceAllString(value, " ")
	value = strings.TrimSpace(value)

	replacements := []struct {
		pattern string
		replace string
	}{
		{`^R\s+`, `RUE `},
		{`^BD\s+`, `BOULEVARD `},
		{`^BLD\s+`, `BOULEVARD `},
		{`^AV(?:E)?\s+`, `AVENUE `},
		{`^PL\s+`, `PLACE `},
		{`^PAS\s+`, `PASSAGE `},
		{`^IMP\s+`, `IMPASSE `},
		{`^SQ\s+`, `SQUARE `},
		{`\bFBG\b`, `FAUBOURG`},
		{`\bFG\b`, `FAUBOURG`},
		{`\bST\b`, `SAINT`},
		{`\bSTE\b`, `SAINTE`},
	}
	for _, item := range replacements {
		value = regexp.MustCompile(item.pattern).ReplaceAllString(value, item.replace)
	}

	value = regexp.MustCompile(`\s+`).ReplaceAllString(value, " ")
	return strings.TrimSpace(value)
}

func addUnique(values *[]string, value string) {
	for _, existing := range *values {
		if existing == value {
			return
		}
	}
	*values = append(*values, value)
}

func stripAccents(value string) string {
	replacer := strings.NewReplacer(
		"À", "A", "Á", "A", "Â", "A", "Ã", "A", "Ä", "A", "Å", "A",
		"Ç", "C", "È", "E", "É", "E", "Ê", "E", "Ë", "E",
		"Ì", "I", "Í", "I", "Î", "I", "Ï", "I",
		"Ñ", "N", "Ò", "O", "Ó", "O", "Ô", "O", "Õ", "O", "Ö", "O",
		"Ù", "U", "Ú", "U", "Û", "U", "Ü", "U", "Ý", "Y",
		"à", "a", "á", "a", "â", "a", "ã", "a", "ä", "a", "å", "a",
		"ç", "c", "è", "e", "é", "e", "ê", "e", "ë", "e",
		"ì", "i", "í", "i", "î", "i", "ï", "i",
		"ñ", "n", "ò", "o", "ó", "o", "ô", "o", "õ", "o", "ö", "o",
		"ù", "u", "ú", "u", "û", "u", "ü", "u", "ý", "y", "ÿ", "y",
		"Œ", "OE", "œ", "oe", "Æ", "AE", "æ", "ae",
	)
	return replacer.Replace(value)
}
