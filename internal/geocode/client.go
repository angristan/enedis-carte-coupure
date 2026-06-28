package geocode

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"enedis-carte-coupure/internal/cache"
)

const (
	PrimaryEndpoint  = "https://data.geopf.fr/geocodage/search"
	FallbackEndpoint = "https://api-adresse.data.gouv.fr/search/"
)

type Client struct {
	httpClient *http.Client
	cachePath  string
	cacheStore cache.JSONStore
	cache      map[string]Result
	dirtyKeys  map[string]struct{}
	mu         sync.Mutex
	dirty      bool
}

type Result struct {
	Status   string   `json:"status"`
	Query    string   `json:"query"`
	Lng      float64  `json:"lng,omitempty"`
	Lat      float64  `json:"lat,omitempty"`
	Label    string   `json:"label,omitempty"`
	Score    *float64 `json:"score,omitempty"`
	Type     string   `json:"type,omitempty"`
	Postcode string   `json:"postcode,omitempty"`
	Citycode string   `json:"citycode,omitempty"`
	Message  string   `json:"message,omitempty"`
	Cached   bool     `json:"-"`
}

type apiResponse struct {
	Features []struct {
		Geometry struct {
			Coordinates []float64 `json:"coordinates"`
		} `json:"geometry"`
		Properties struct {
			Label    string   `json:"label"`
			Score    *float64 `json:"score"`
			Type     string   `json:"type"`
			Postcode string   `json:"postcode"`
			Citycode string   `json:"citycode"`
		} `json:"properties"`
	} `json:"features"`
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
		dirtyKeys:  map[string]struct{}{},
	}
	for _, option := range options {
		option(client)
	}
	client.load()
	if client.cacheStore != nil && len(client.cache) > 0 {
		for key := range client.cache {
			client.dirtyKeys[key] = struct{}{}
		}
		client.dirty = true
	}
	return client
}

func (c *Client) Street(ctx context.Context, query string) Result {
	query = strings.TrimSpace(query)
	key := strings.ToUpper(stripAccents(query))

	c.mu.Lock()
	if cached, ok := c.cache[key]; ok {
		c.mu.Unlock()
		cached.Cached = true
		return cached
	}
	c.mu.Unlock()

	if c.cacheStore != nil {
		var cached Result
		found, err := c.cacheStore.Get(ctx, key, &cached)
		if err == nil && found {
			c.mu.Lock()
			c.cache[key] = cached
			c.mu.Unlock()
			cached.Cached = true
			return cached
		}
	}

	result, err := c.lookup(ctx, PrimaryEndpoint, query)
	if err != nil || result.Status != "ok" {
		fallback, fallbackErr := c.lookup(ctx, FallbackEndpoint, query)
		if fallbackErr == nil {
			result = fallback
			err = nil
		}
	}
	if err != nil {
		return Result{Status: "error", Query: query, Message: err.Error()}
	}

	if result.Status == "ok" || result.Status == "miss" {
		c.store(key, result)
	}
	return result
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
	data, err := json.MarshalIndent(c.cache, "", "  ")
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

func (c *Client) lookup(ctx context.Context, endpoint, queryText string) (Result, error) {
	requestURL, _ := url.Parse(endpoint)
	params := requestURL.Query()
	params.Set("q", queryText)
	params.Set("limit", "1")
	requestURL.RawQuery = params.Encode()

	reqCtx, cancel := context.WithTimeout(ctx, 18*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "enedis-carte-coupure/1.0")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, fmt.Errorf("%s returned %s", endpoint, resp.Status)
	}

	var decoded apiResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&decoded); err != nil {
		return Result{}, err
	}
	if len(decoded.Features) == 0 || len(decoded.Features[0].Geometry.Coordinates) < 2 {
		return Result{Status: "miss", Query: queryText}, nil
	}

	feature := decoded.Features[0]
	return Result{
		Status:   "ok",
		Query:    queryText,
		Lng:      feature.Geometry.Coordinates[0],
		Lat:      feature.Geometry.Coordinates[1],
		Label:    feature.Properties.Label,
		Score:    feature.Properties.Score,
		Type:     feature.Properties.Type,
		Postcode: feature.Properties.Postcode,
		Citycode: feature.Properties.Citycode,
	}, nil
}

func (c *Client) load() {
	data, err := os.ReadFile(c.cachePath)
	if err != nil {
		return
	}
	if err := json.Unmarshal(data, &c.cache); err != nil {
		c.cache = map[string]Result{}
		return
	}
	for key, result := range c.cache {
		if result.Status == "error" {
			delete(c.cache, key)
		}
	}
}

func (c *Client) store(key string, result Result) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache[key] = result
	c.dirtyKeys[key] = struct{}{}
	c.dirty = true
}

func (c *Client) saveRedis() error {
	c.mu.Lock()
	if !c.dirty {
		c.mu.Unlock()
		return nil
	}
	pending := map[string]Result{}
	for key := range c.dirtyKeys {
		pending[key] = c.cache[key]
	}
	c.dirty = false
	c.dirtyKeys = map[string]struct{}{}
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	for key, result := range pending {
		if err := c.cacheStore.Set(ctx, key, result); err != nil {
			c.mu.Lock()
			for restoreKey := range pending {
				c.dirtyKeys[restoreKey] = struct{}{}
			}
			c.dirty = true
			c.mu.Unlock()
			return err
		}
	}
	return nil
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
