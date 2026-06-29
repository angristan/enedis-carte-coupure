package communes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"enedis-carte-coupure/internal/enedis"
	"enedis-carte-coupure/internal/geo"
)

const Endpoint = "https://geo.api.gouv.fr/communes"

const lookupConcurrency = 8

type Client struct {
	httpClient *http.Client
	cache      map[string]lookupResult
	mu         sync.Mutex
}

type Commune struct {
	Name      string   `json:"name"`
	Code      string   `json:"code"`
	Postcodes []string `json:"postcodes,omitempty"`
	Center    Center   `json:"center,omitempty"`
}

type Center struct {
	Type        string    `json:"type,omitempty"`
	Coordinates []float64 `json:"coordinates,omitempty"`
}

type apiCommune struct {
	Nom          string   `json:"nom"`
	Code         string   `json:"code"`
	CodesPostaux []string `json:"codesPostaux"`
	Centre       Center   `json:"centre"`
}

type lookupResult struct {
	Commune Commune
	Found   bool
}

func NewClient(httpClient *http.Client) *Client {
	return &Client{
		httpClient: httpClient,
		cache:      map[string]lookupResult{},
	}
}

func (c *Client) ForBounds(ctx context.Context, bounds geo.Bounds, maxCommunes int) ([]Commune, error) {
	points := samplePoints(bounds)
	type pointResult struct {
		Index   int
		Commune Commune
		Found   bool
		Err     error
	}

	jobs := make(chan int)
	results := make(chan pointResult, len(points))
	var wg sync.WaitGroup
	workerCount := min(lookupConcurrency, len(points))
	for range workerCount {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				commune, found, err := c.lookupPoint(ctx, points[index])
				results <- pointResult{
					Index:   index,
					Commune: commune,
					Found:   found,
					Err:     err,
				}
			}
		}()
	}
	for index := range points {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	close(results)

	ordered := make([]pointResult, 0, len(points))
	var lastErr error
	for result := range results {
		if result.Err != nil {
			lastErr = result.Err
		}
		ordered = append(ordered, result)
	}
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].Index < ordered[j].Index
	})

	seen := map[string]Commune{}
	for _, result := range ordered {
		if result.Err != nil || !result.Found {
			continue
		}
		if _, ok := seen[result.Commune.Code]; ok {
			continue
		}
		seen[result.Commune.Code] = result.Commune
	}
	if maxCommunes > 0 && len(seen) > maxCommunes {
		return nil, fmt.Errorf("viewport covers more than %d communes; zoom in", maxCommunes)
	}
	communes := make([]Commune, 0, len(seen))
	for _, commune := range seen {
		communes = append(communes, commune)
	}
	sort.Slice(communes, func(i, j int) bool {
		return communes[i].Code < communes[j].Code
	})
	if len(communes) == 0 && lastErr != nil {
		return nil, lastErr
	}
	return communes, nil
}

func (c Commune) EnedisQuery() enedis.Query {
	postcode := ""
	if len(c.Postcodes) > 0 {
		postcode = c.Postcodes[0]
	}

	query := enedis.Query{
		Insee:      c.Code,
		Type:       "municipality",
		Adresse:    c.Name,
		CPVille:    strings.TrimSpace(c.Name + " " + postcode),
		Name:       c.Name,
		City:       c.Name,
		Department: departmentFromCode(c.Code),
	}
	if len(c.Center.Coordinates) >= 2 {
		query.Longitude = fmt.Sprintf("%.6f", c.Center.Coordinates[0])
		query.Latitude = fmt.Sprintf("%.6f", c.Center.Coordinates[1])
	}
	return query
}

func (c *Client) lookupPoint(ctx context.Context, point geo.Point) (Commune, bool, error) {
	key := fmt.Sprintf("%.5f,%.5f", point.Lat, point.Lng)
	c.mu.Lock()
	if cached, ok := c.cache[key]; ok {
		c.mu.Unlock()
		return cached.Commune, cached.Found, nil
	}
	c.mu.Unlock()

	requestURL, _ := url.Parse(Endpoint)
	params := requestURL.Query()
	params.Set("lat", fmt.Sprintf("%.6f", point.Lat))
	params.Set("lon", fmt.Sprintf("%.6f", point.Lng))
	params.Set("fields", "nom,code,codesPostaux,centre")
	params.Set("format", "json")
	requestURL.RawQuery = params.Encode()

	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return Commune{}, false, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "enedis-carte-coupure/1.0")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return Commune{}, false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Commune{}, false, fmt.Errorf("%s returned %s", Endpoint, resp.Status)
	}

	var decoded []apiCommune
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&decoded); err != nil {
		return Commune{}, false, fmt.Errorf("decode communes: %w", err)
	}

	result := lookupResult{}
	if len(decoded) > 0 && decoded[0].Code != "" {
		result = lookupResult{
			Found: true,
			Commune: Commune{
				Name:      decoded[0].Nom,
				Code:      decoded[0].Code,
				Postcodes: decoded[0].CodesPostaux,
				Center:    decoded[0].Centre,
			},
		}
	}

	c.mu.Lock()
	c.cache[key] = result
	c.mu.Unlock()

	return result.Commune, result.Found, nil
}

func samplePoints(bounds geo.Bounds) []geo.Point {
	center := bounds.Center()
	points := []geo.Point{center}
	seen := map[string]struct{}{pointKey(center): {}}

	const grid = 5
	for latIndex := 0; latIndex < grid; latIndex++ {
		lat := interpolate(bounds.South, bounds.North, latIndex, grid)
		for lngIndex := 0; lngIndex < grid; lngIndex++ {
			lng := interpolate(bounds.West, bounds.East, lngIndex, grid)
			point := geo.Point{Lat: lat, Lng: lng}
			key := pointKey(point)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			points = append(points, point)
		}
	}
	return points
}

func interpolate(minValue, maxValue float64, index, count int) float64 {
	if count <= 1 {
		return (minValue + maxValue) / 2
	}
	return minValue + (maxValue-minValue)*float64(index)/float64(count-1)
}

func pointKey(point geo.Point) string {
	return fmt.Sprintf("%.5f,%.5f", point.Lat, point.Lng)
}

func departmentFromCode(code string) string {
	if len(code) >= 3 && (strings.HasPrefix(code, "97") || strings.HasPrefix(code, "98")) {
		return code[:3]
	}
	if len(code) >= 2 {
		return code[:2]
	}
	return code
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
