package streetgeom

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
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
	"enedis-carte-coupure/internal/geo"
)

const (
	PrimaryEndpoint       = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
	FallbackEndpoint      = "https://lz4.overpass-api.de/api/interpreter"
	cacheFileVersion      = 3
	defaultIndexKey       = "paris"
	viewportIndexPrefix   = "streets:"
	viewportPaddingRatio  = 0.08
	viewportSnapGrid      = 0.005
	maxCachedIndexes      = 64
	redisIndexTTL         = 24 * time.Hour
	maxNameRegexBatchSize = 36
	maxPointMatchMeters   = 1800
	pointMatchSlackMeters = 350
	componentJoinMeters   = 35
)

type Client struct {
	httpClient  *http.Client
	cachePath   string
	cacheStore  cache.JSONStore
	indexes     map[string]cacheFile
	indexAccess map[string]time.Time
	loadedRedis map[string]bool
	mu          sync.Mutex
	dirty       map[string]struct{}
}

type Point struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type Request struct {
	ID    string
	Name  string
	Point *Point
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
	Version   int               `json:"version,omitempty"`
	UpdatedAt string            `json:"updatedAt"`
	Source    string            `json:"source"`
	Bounds    geo.Bounds        `json:"bounds"`
	Streets   map[string]Result `json:"streets"`
}

type diskCacheFile struct {
	Version int                  `json:"version"`
	Indexes map[string]cacheFile `json:"indexes"`
}

type ttlStore interface {
	SetTTL(ctx context.Context, key string, value any, ttl time.Duration) error
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
		httpClient:  httpClient,
		cachePath:   cachePath,
		indexes:     map[string]cacheFile{},
		indexAccess: map[string]time.Time{},
		loadedRedis: map[string]bool{},
		dirty:       map[string]struct{}{},
	}
	for _, option := range options {
		option(client)
	}
	client.load()
	if client.cacheStore != nil && len(client.indexes) > 0 {
		for key := range client.indexes {
			client.dirty[key] = struct{}{}
		}
	}
	return client
}

func (c *Client) Streets(ctx context.Context, names []string) map[string]Result {
	return c.StreetRequests(ctx, requestsFromNames(names))
}

func (c *Client) StreetsInBounds(ctx context.Context, names []string, bounds geo.Bounds) map[string]Result {
	return c.StreetRequestsInBounds(ctx, requestsFromNames(names), bounds)
}

func (c *Client) StreetRequests(ctx context.Context, requests []Request) map[string]Result {
	return c.streetRequests(ctx, requests, defaultBounds(), defaultIndexKey)
}

func (c *Client) StreetRequestsInBounds(ctx context.Context, requests []Request, bounds geo.Bounds) map[string]Result {
	indexBounds := bounds.Padded(viewportPaddingRatio).Snapped(viewportSnapGrid)
	return c.streetRequests(ctx, requests, indexBounds, viewportIndexPrefix+indexBounds.CacheKey())
}

func (c *Client) streetRequests(ctx context.Context, requests []Request, bounds geo.Bounds, indexKey string) map[string]Result {
	requested := requestedRequests(requests)
	if len(requested) == 0 {
		return map[string]Result{}
	}

	c.mu.Lock()
	index := c.indexes[indexKey]
	c.touchIndexLocked(indexKey)
	missing := missingKeys(index.Streets, requested)
	c.mu.Unlock()

	if len(missing) > 0 && c.cacheStore != nil {
		_ = c.loadRedis(ctx, indexKey)
		c.mu.Lock()
		index = c.indexes[indexKey]
		c.touchIndexLocked(indexKey)
		missing = missingKeys(index.Streets, requested)
		c.mu.Unlock()
	}

	if len(missing) > 0 {
		if err := c.refresh(ctx, bounds, indexKey, missing); err != nil {
			results := map[string]Result{}
			for key, request := range requested {
				results[key] = Result{Status: "error", Query: request.Name, Message: err.Error()}
			}
			return results
		}
	}

	results := map[string]Result{}
	c.mu.Lock()
	defer c.mu.Unlock()
	index = c.indexes[indexKey]
	c.touchIndexLocked(indexKey)
	if index.Streets == nil {
		index = cacheFile{Version: cacheFileVersion, Bounds: bounds, Streets: map[string]Result{}}
	}
	for resultKey, request := range requested {
		nameKey := Key(request.Name)
		result, ok := index.Streets[nameKey]
		if !ok {
			result = Result{
				Status:    "miss",
				Query:     request.Name,
				UpdatedAt: index.UpdatedAt,
			}
			index.Streets[nameKey] = result
			c.dirty[indexKey] = struct{}{}
		}
		result.Query = request.Name
		if request.Point != nil {
			result = filterResultNearPoint(result, *request.Point)
			result.Query = request.Name
		}
		results[resultKey] = result
	}
	c.indexes[indexKey] = index
	c.evictIndexesLocked()
	return results
}

func (c *Client) Save() error {
	if c.cacheStore != nil {
		return c.saveRedis()
	}

	c.mu.Lock()
	if len(c.dirty) == 0 {
		c.mu.Unlock()
		return nil
	}
	payload := diskCacheFile{
		Version: cacheFileVersion,
		Indexes: map[string]cacheFile{},
	}
	for key, index := range c.indexes {
		index.Version = cacheFileVersion
		payload.Indexes[key] = index
	}
	c.dirty = map[string]struct{}{}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		c.mu.Unlock()
		return err
	}
	c.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(c.cachePath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(c.cachePath, append(data, '\n'), 0o644)
}

func (c *Client) saveRedis() error {
	c.mu.Lock()
	if len(c.dirty) == 0 {
		c.mu.Unlock()
		return nil
	}
	pending := map[string]cacheFile{}
	for key := range c.dirty {
		payload := c.indexes[key]
		payload.Version = cacheFileVersion
		pending[key] = payload
	}
	c.dirty = map[string]struct{}{}
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for key, payload := range pending {
		var err error
		if store, ok := c.cacheStore.(ttlStore); ok {
			err = store.SetTTL(ctx, key, payload, redisIndexTTL)
		} else {
			err = c.cacheStore.Set(ctx, key, payload)
		}
		if err != nil {
			c.mu.Lock()
			for dirtyKey := range pending {
				c.dirty[dirtyKey] = struct{}{}
			}
			c.mu.Unlock()
			return err
		}
	}
	return nil
}

func (c *Client) refresh(ctx context.Context, bounds geo.Bounds, indexKey string, nameKeys []string) error {
	grouped, source, err := c.fetch(ctx, bounds, nameKeys)
	if err != nil {
		return err
	}

	now := time.Now().Format(time.RFC3339)
	for key, result := range grouped {
		result.UpdatedAt = now
		grouped[key] = result
	}

	c.mu.Lock()
	index := c.indexes[indexKey]
	if index.Streets == nil || index.Version != cacheFileVersion {
		index = cacheFile{
			Version: cacheFileVersion,
			Bounds:  bounds,
			Streets: map[string]Result{},
		}
	}
	index.Version = cacheFileVersion
	index.UpdatedAt = now
	index.Source = source
	index.Bounds = bounds
	for key, result := range grouped {
		index.Streets[key] = result
	}
	c.indexes[indexKey] = index
	c.touchIndexLocked(indexKey)
	c.evictIndexesLocked()
	c.dirty[indexKey] = struct{}{}
	c.mu.Unlock()
	return nil
}

func (c *Client) fetch(ctx context.Context, bounds geo.Bounds, nameKeys []string) (map[string]Result, string, error) {
	var lastErr error
	for _, endpoint := range []string{PrimaryEndpoint, FallbackEndpoint} {
		grouped, err := c.lookup(ctx, endpoint, bounds, nameKeys)
		if err == nil {
			return grouped, endpoint, nil
		}
		lastErr = err
	}
	return nil, "", lastErr
}

func (c *Client) lookup(ctx context.Context, endpoint string, bounds geo.Bounds, nameKeys []string) (map[string]Result, error) {
	query := buildLookupQuery(bounds, nameKeys)
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

	var diskPayload diskCacheFile
	if err := json.Unmarshal(data, &diskPayload); err == nil && diskPayload.Indexes != nil {
		if diskPayload.Version == cacheFileVersion {
			c.indexes = diskPayload.Indexes
			now := time.Now()
			for key := range c.indexes {
				c.indexAccess[key] = now
			}
		}
		return
	}

	var payload cacheFile
	if err := json.Unmarshal(data, &payload); err == nil && payload.Streets != nil {
		if payload.Version != 0 && payload.Version != cacheFileVersion {
			return
		}
		if payload.Bounds == (geo.Bounds{}) {
			payload.Bounds = defaultBounds()
		}
		payload.Version = cacheFileVersion
		c.indexes[defaultIndexKey] = payload
		c.indexAccess[defaultIndexKey] = time.Now()
		return
	}

	legacy := map[string]Result{}
	if err := json.Unmarshal(data, &legacy); err == nil {
		c.indexes[defaultIndexKey] = cacheFile{
			Version: cacheFileVersion,
			Bounds:  defaultBounds(),
			Streets: legacy,
		}
		c.indexAccess[defaultIndexKey] = time.Now()
	}
}

func (c *Client) loadRedis(ctx context.Context, indexKey string) error {
	c.mu.Lock()
	if c.loadedRedis[indexKey] {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	var payload cacheFile
	loadCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	found, err := c.cacheStore.Get(loadCtx, indexKey, &payload)
	if err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.loadedRedis[indexKey] = true
	if !found || payload.Streets == nil {
		return nil
	}
	if payload.Version != cacheFileVersion {
		return nil
	}
	c.indexes[indexKey] = payload
	c.touchIndexLocked(indexKey)
	c.evictIndexesLocked()
	delete(c.dirty, indexKey)
	return nil
}

func (c *Client) touchIndexLocked(indexKey string) {
	c.indexAccess[indexKey] = time.Now()
}

func (c *Client) evictIndexesLocked() {
	for len(c.indexes) > maxCachedIndexes {
		var oldestKey string
		var oldestTime time.Time
		for key := range c.indexes {
			if key == defaultIndexKey {
				continue
			}
			accessed := c.indexAccess[key]
			if oldestKey == "" || accessed.Before(oldestTime) {
				oldestKey = key
				oldestTime = accessed
			}
		}
		if oldestKey == "" {
			return
		}
		delete(c.indexes, oldestKey)
		delete(c.indexAccess, oldestKey)
		delete(c.loadedRedis, oldestKey)
		delete(c.dirty, oldestKey)
	}
}

func defaultBounds() geo.Bounds {
	return geo.Bounds{South: 48.815, West: 2.224, North: 48.902, East: 2.470}
}

func requestsFromNames(names []string) []Request {
	requests := make([]Request, 0, len(names))
	for _, name := range names {
		requests = append(requests, Request{Name: name})
	}
	return requests
}

func requestedRequests(requests []Request) map[string]Request {
	requested := map[string]Request{}
	for _, request := range requests {
		request.Name = strings.TrimSpace(request.Name)
		nameKey := Key(request.Name)
		if nameKey == "" {
			continue
		}
		resultKey := strings.TrimSpace(request.ID)
		if resultKey == "" {
			resultKey = nameKey
		}
		requested[resultKey] = request
	}
	return requested
}

func missingKeys(cache map[string]Result, requested map[string]Request) []string {
	seen := map[string]struct{}{}
	missing := []string{}
	for _, request := range requested {
		nameKey := Key(request.Name)
		if _, ok := seen[nameKey]; ok {
			continue
		}
		seen[nameKey] = struct{}{}
		if _, ok := cache[nameKey]; !ok {
			missing = append(missing, nameKey)
		}
	}
	return missing
}

func buildLookupQuery(bounds geo.Bounds, nameKeys []string) string {
	nameKeys = uniqueSortedNameKeys(nameKeys)
	if len(nameKeys) == 0 {
		return fmt.Sprintf(`[out:json][timeout:45];way["highway"]["name"](%s);out tags geom;`, bounds.OverpassBBox())
	}

	var builder strings.Builder
	builder.WriteString("[out:json][timeout:45];(")
	for start := 0; start < len(nameKeys); start += maxNameRegexBatchSize {
		end := min(start+maxNameRegexBatchSize, len(nameKeys))
		regexes := make([]string, 0, end-start)
		for _, nameKey := range nameKeys[start:end] {
			regex := nameRegexFromKey(nameKey)
			if regex != "" {
				regexes = append(regexes, regex)
			}
		}
		if len(regexes) == 0 {
			continue
		}
		builder.WriteString(`way["highway"]["name"~"^ *(`)
		builder.WriteString(escapeOverpassRegex(strings.Join(regexes, "|")))
		builder.WriteString(`) *$",i](`)
		builder.WriteString(bounds.OverpassBBox())
		builder.WriteString(");")
	}
	builder.WriteString(");out tags geom;")
	return builder.String()
}

func uniqueSortedNameKeys(nameKeys []string) []string {
	seen := map[string]struct{}{}
	unique := []string{}
	for _, nameKey := range nameKeys {
		nameKey = strings.TrimSpace(nameKey)
		if nameKey == "" {
			continue
		}
		if _, ok := seen[nameKey]; ok {
			continue
		}
		seen[nameKey] = struct{}{}
		unique = append(unique, nameKey)
	}
	sort.Strings(unique)
	return unique
}

func nameRegexFromKey(nameKey string) string {
	tokens := strings.Fields(nameKey)
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		part := tokenRegex(token)
		if part == "" {
			continue
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, `[ ./'’-]+`)
}

func tokenRegex(token string) string {
	var builder strings.Builder
	for _, r := range token {
		switch r {
		case 'A':
			builder.WriteString(`[AÀÁÂÃÄÅàáâãäå]`)
		case 'C':
			builder.WriteString(`[CÇç]`)
		case 'E':
			builder.WriteString(`[EÈÉÊËèéêë]`)
		case 'I':
			builder.WriteString(`[IÌÍÎÏìíîï]`)
		case 'N':
			builder.WriteString(`[NÑñ]`)
		case 'O':
			builder.WriteString(`[OÒÓÔÕÖòóôõö]`)
		case 'U':
			builder.WriteString(`[UÙÚÛÜùúûü]`)
		case 'Y':
			builder.WriteString(`[YÝŸýÿ]`)
		default:
			if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
				builder.WriteRune(r)
			} else {
				builder.WriteString(regexp.QuoteMeta(string(r)))
			}
		}
	}
	return builder.String()
}

func escapeOverpassRegex(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return value
}

func filterResultNearPoint(result Result, point Point) Result {
	if result.Status != "ok" || len(result.Lines) == 0 {
		return result
	}

	components := connectedComponents(result.Lines)
	if len(components) == 0 {
		return result
	}

	distances := make([]float64, len(components))
	closest := math.Inf(1)
	for index, component := range components {
		distance := componentDistanceMeters(result.Lines, component, point)
		distances[index] = distance
		if distance < closest {
			closest = distance
		}
	}
	if math.IsInf(closest, 1) || closest > maxPointMatchMeters {
		result.Status = "miss"
		result.Lines = nil
		result.Message = fmt.Sprintf("no OSM geometry named %q within %dm of geocoded point", result.Query, maxPointMatchMeters)
		return result
	}

	limit := math.Min(maxPointMatchMeters, closest+pointMatchSlackMeters)
	filtered := make([][]Point, 0, len(result.Lines))
	for index, component := range components {
		if distances[index] > limit {
			continue
		}
		for _, lineIndex := range component {
			filtered = append(filtered, result.Lines[lineIndex])
		}
	}
	if len(filtered) == 0 {
		return result
	}
	result.Lines = filtered
	return result
}

func connectedComponents(lines [][]Point) [][]int {
	visited := make([]bool, len(lines))
	components := [][]int{}
	for index := range lines {
		if visited[index] {
			continue
		}
		visited[index] = true
		component := []int{index}
		queue := []int{index}
		for len(queue) > 0 {
			current := queue[0]
			queue = queue[1:]
			for candidate := range lines {
				if visited[candidate] || !linesTouch(lines[current], lines[candidate]) {
					continue
				}
				visited[candidate] = true
				component = append(component, candidate)
				queue = append(queue, candidate)
			}
		}
		components = append(components, component)
	}
	return components
}

func linesTouch(left, right []Point) bool {
	leftEndpoints, ok := endpoints(left)
	if !ok {
		return false
	}
	rightEndpoints, ok := endpoints(right)
	if !ok {
		return false
	}
	for _, leftPoint := range leftEndpoints {
		for _, rightPoint := range rightEndpoints {
			if pointDistanceMeters(leftPoint, rightPoint) <= componentJoinMeters {
				return true
			}
		}
	}
	return false
}

func endpoints(line []Point) ([2]Point, bool) {
	if len(line) == 0 {
		return [2]Point{}, false
	}
	return [2]Point{line[0], line[len(line)-1]}, true
}

func componentDistanceMeters(lines [][]Point, component []int, point Point) float64 {
	closest := math.Inf(1)
	for _, lineIndex := range component {
		distance := lineDistanceMeters(lines[lineIndex], point)
		if distance < closest {
			closest = distance
		}
	}
	return closest
}

func lineDistanceMeters(line []Point, point Point) float64 {
	if len(line) == 0 {
		return math.Inf(1)
	}
	if len(line) == 1 {
		return pointDistanceMeters(line[0], point)
	}
	closest := math.Inf(1)
	for index := 1; index < len(line); index++ {
		distance := segmentDistanceMeters(point, line[index-1], line[index])
		if distance < closest {
			closest = distance
		}
	}
	return closest
}

func segmentDistanceMeters(point, start, end Point) float64 {
	px, py := projectMeters(point, point.Lat)
	sx, sy := projectMeters(start, point.Lat)
	ex, ey := projectMeters(end, point.Lat)
	dx := ex - sx
	dy := ey - sy
	if dx == 0 && dy == 0 {
		return math.Hypot(px-sx, py-sy)
	}
	t := ((px-sx)*dx + (py-sy)*dy) / (dx*dx + dy*dy)
	t = math.Max(0, math.Min(1, t))
	x := sx + t*dx
	y := sy + t*dy
	return math.Hypot(px-x, py-y)
}

func pointDistanceMeters(left, right Point) float64 {
	lx, ly := projectMeters(left, left.Lat)
	rx, ry := projectMeters(right, left.Lat)
	return math.Hypot(lx-rx, ly-ry)
}

func projectMeters(point Point, originLat float64) (float64, float64) {
	const earthRadiusMeters = 6371000
	latRad := point.Lat * math.Pi / 180
	lngRad := point.Lng * math.Pi / 180
	originLatRad := originLat * math.Pi / 180
	return earthRadiusMeters * lngRad * math.Cos(originLatRad), earthRadiusMeters * latRad
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
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
