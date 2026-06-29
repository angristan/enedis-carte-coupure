package outages

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"enedis-carte-coupure/internal/enedis"
	"enedis-carte-coupure/internal/geo"
	"enedis-carte-coupure/internal/geocode"
	"enedis-carte-coupure/internal/streetgeom"
)

type Geocoder interface {
	Street(ctx context.Context, query string) geocode.Result
	Save() error
}

type GeometryProvider interface {
	Streets(ctx context.Context, names []string) map[string]streetgeom.Result
}

type BoundedGeometryProvider interface {
	StreetsInBounds(ctx context.Context, names []string, bounds geo.Bounds) map[string]streetgeom.Result
}

type PointAwareGeometryProvider interface {
	StreetRequests(ctx context.Context, requests []streetgeom.Request) map[string]streetgeom.Result
}

type PointAwareBoundedGeometryProvider interface {
	StreetRequestsInBounds(ctx context.Context, requests []streetgeom.Request, bounds geo.Bounds) map[string]streetgeom.Result
}

type Normalizer struct {
	geocoder   Geocoder
	geometries GeometryProvider
}

type Input struct {
	Raw   enedis.Response
	Query enedis.Query
}

type Response struct {
	UpdatedAt string          `json:"updatedAt"`
	Source    Source          `json:"source"`
	Query     enedis.Query    `json:"query"`
	Queries   []enedis.Query  `json:"queries,omitempty"`
	Viewport  *geo.Bounds     `json:"viewport,omitempty"`
	Communes  []Commune       `json:"communes,omitempty"`
	Warnings  []string        `json:"warnings,omitempty"`
	Polygon   json.RawMessage `json:"polygon"`
	Stats     Stats           `json:"stats"`
	Outages   []Outage        `json:"outages"`
	Streets   []Street        `json:"streets"`
	Recap     json.RawMessage `json:"recap"`
	Crises    json.RawMessage `json:"crises"`
	Raw       json.RawMessage `json:"raw,omitempty"`
}

type Source struct {
	EnedisEndpoint           string `json:"enedisEndpoint"`
	GeocoderEndpoint         string `json:"geocoderEndpoint"`
	GeocoderFallbackEndpoint string `json:"geocoderFallbackEndpoint"`
	StreetGeometryEndpoint   string `json:"streetGeometryEndpoint"`
}

type Commune struct {
	Code      string    `json:"code"`
	Name      string    `json:"name"`
	Postcodes []string  `json:"postcodes,omitempty"`
	Center    geo.Point `json:"center,omitempty"`
}

type Stats struct {
	Outages              int `json:"outages"`
	AddressRows          int `json:"addressRows"`
	Streets              int `json:"streets"`
	GeocodedStreets      int `json:"geocodedStreets"`
	GeocodeMisses        int `json:"geocodeMisses"`
	StreetGeometry       int `json:"streetGeometry"`
	StreetGeometryMisses int `json:"streetGeometryMisses"`
	CompteurIncidentHTA  int `json:"compteurIncidentHTA"`
	CompteurTravauxHTA   int `json:"compteurTravauxHTA"`
	CompteurBT           int `json:"compteurBT"`
}

type Outage struct {
	ID                 string           `json:"id"`
	Status             string           `json:"status"`
	Type               string           `json:"type"`
	EtatElectrique     int              `json:"etatElectrique"`
	CodeInsee          string           `json:"codeInsee"`
	DateCoupure        string           `json:"dateCoupure"`
	DateRealimentation string           `json:"dateRealimentation"`
	NbFoyersCoupes     int              `json:"nbFoyersCoupes"`
	Addresses          []enedis.Address `json:"addresses"`
}

type Street struct {
	Key                string             `json:"key"`
	Label              string             `json:"label"`
	NormalizedName     string             `json:"normalizedName"`
	City               string             `json:"city"`
	Postcode           string             `json:"postcode"`
	Localisations      []string           `json:"localisations"`
	OutageIDs          []string           `json:"outageIds"`
	OutageTypes        []string           `json:"outageTypes"`
	FirstSeenAt        string             `json:"firstSeenAt"`
	EstimatedRestoreAt string             `json:"estimatedRestoreAt"`
	NbFoyersCoupes     int                `json:"nbFoyersCoupes"`
	Geocode            *geocode.Result    `json:"geocode,omitempty"`
	Geometry           *streetgeom.Result `json:"geometry,omitempty"`
}

type parsedStreet struct {
	Label          string
	NormalizedName string
	NormalizedKey  string
	City           string
	Postcode       string
}

func NewNormalizer(geocoder Geocoder, geometries GeometryProvider) *Normalizer {
	return &Normalizer{geocoder: geocoder, geometries: geometries}
}

func (n *Normalizer) Normalize(ctx context.Context, raw enedis.Response, query enedis.Query, shouldGeocode bool) Response {
	return n.NormalizeWithBounds(ctx, raw, query, shouldGeocode, nil)
}

func (n *Normalizer) NormalizeWithBounds(ctx context.Context, raw enedis.Response, query enedis.Query, shouldGeocode bool, geometryBounds *geo.Bounds) Response {
	return n.NormalizeSet(ctx, []Input{{Raw: raw, Query: query}}, shouldGeocode, geometryBounds)
}

func (n *Normalizer) NormalizeSet(ctx context.Context, inputs []Input, shouldGeocode bool, geometryBounds *geo.Bounds) Response {
	streetMap := map[string]*Street{}
	outageMap := map[string]*Outage{}
	polygons := make([]json.RawMessage, 0, len(inputs))
	queries := make([]enedis.Query, 0, len(inputs))
	addressRows := 0
	compteurIncidentHTA := 0
	compteurTravauxHTA := 0
	compteurBT := 0
	var recap json.RawMessage
	var crises json.RawMessage

	for _, input := range inputs {
		raw := input.Raw
		query := input.Query
		queries = append(queries, query)
		if len(raw.Polygon) > 0 {
			polygons = append(polygons, raw.Polygon)
		}
		compteurIncidentHTA += raw.ResultMegacache.CompteurIncidentHTA
		compteurTravauxHTA += raw.ResultMegacache.CompteurTravauxHTA
		compteurBT += raw.ResultMegacache.CompteurBT
		if len(recap) == 0 && len(raw.ResultMegacache.Recap) > 0 {
			recap = raw.ResultMegacache.Recap
		}
		if len(crises) == 0 && len(raw.ResultMegacache.ListeCrises) > 0 {
			crises = raw.ResultMegacache.ListeCrises
		}

		for outageIndex, outage := range raw.ResultMegacache.ListeCoupuresInfoReseau {
			outageKey := outage.IDCoupure
			if outageKey == "" {
				outageKey = query.Insee + ":" + strconv.Itoa(outageIndex)
			}
			if existing, ok := outageMap[outageKey]; ok {
				existing.DateCoupure = earliestFrenchDate(existing.DateCoupure, outage.DateCoupure)
				existing.DateRealimentation = latestFrenchDate(existing.DateRealimentation, outage.DateRealimentation)
				existing.NbFoyersCoupes += outage.NbFoyersCoupes
				for _, address := range outage.ListeAdresses {
					addUniqueAddress(&existing.Addresses, address)
				}
			} else {
				addresses := make([]enedis.Address, 0, len(outage.ListeAdresses))
				for _, address := range outage.ListeAdresses {
					addUniqueAddress(&addresses, address)
				}
				outageMap[outageKey] = &Outage{
					ID:                 outage.IDCoupure,
					Status:             outage.EtatCoupure,
					Type:               outage.IncidentCoupure,
					EtatElectrique:     outage.EtatElectrique,
					CodeInsee:          outage.CodeInsee,
					DateCoupure:        outage.DateCoupure,
					DateRealimentation: outage.DateRealimentation,
					NbFoyersCoupes:     outage.NbFoyersCoupes,
					Addresses:          addresses,
				}
			}

			for _, address := range outage.ListeAdresses {
				addressRows++
				parsed := parseLocalisation(address.Localisation, query.City)
				key := strings.Join([]string{
					parsed.NormalizedKey,
					parsed.Postcode,
					strings.ToUpper(stripAccents(parsed.City)),
				}, "|")

				street, ok := streetMap[key]
				if !ok {
					street = &Street{
						Key:            key,
						Label:          parsed.Label,
						NormalizedName: parsed.NormalizedName,
						City:           parsed.City,
						Postcode:       parsed.Postcode,
					}
					streetMap[key] = street
				}

				addUnique(&street.Localisations, address.Localisation)
				addUnique(&street.OutageIDs, outage.IDCoupure)
				addUnique(&street.OutageTypes, fallback(outage.IncidentCoupure, "Incident"))
				street.NbFoyersCoupes += address.NbFoyersCoupes
				street.FirstSeenAt = earliestFrenchDate(street.FirstSeenAt, outage.DateCoupure)
				street.EstimatedRestoreAt = latestFrenchDate(street.EstimatedRestoreAt, outage.DateRealimentation)
			}
		}
	}

	streets := make([]Street, 0, len(streetMap))
	for _, street := range streetMap {
		sort.Strings(street.OutageIDs)
		sort.Strings(street.OutageTypes)
		streets = append(streets, *street)
	}
	sort.Slice(streets, func(i, j int) bool {
		return strings.Compare(streets[i].Label, streets[j].Label) < 0
	})

	if shouldGeocode {
		n.geocodeStreets(ctx, streets)
		n.attachStreetGeometry(ctx, streets, geometryBounds)
	}

	outageList := make([]Outage, 0, len(outageMap))
	for _, outage := range outageMap {
		outageList = append(outageList, *outage)
	}
	sort.Slice(outageList, func(i, j int) bool {
		return strings.Compare(outageList[i].ID, outageList[j].ID) < 0
	})

	stats := Stats{
		Outages:             len(outageList),
		AddressRows:         addressRows,
		Streets:             len(streets),
		CompteurIncidentHTA: compteurIncidentHTA,
		CompteurTravauxHTA:  compteurTravauxHTA,
		CompteurBT:          compteurBT,
	}
	for _, street := range streets {
		if street.Geocode != nil {
			if street.Geocode.Status == "ok" {
				stats.GeocodedStreets++
			} else {
				stats.GeocodeMisses++
			}
		}

		if street.Geometry == nil {
			continue
		}
		if street.Geometry.Status == "ok" && len(street.Geometry.Lines) > 0 {
			stats.StreetGeometry++
		} else {
			stats.StreetGeometryMisses++
		}
	}

	var query enedis.Query
	if len(queries) > 0 {
		query = queries[0]
	}
	response := Response{
		UpdatedAt: time.Now().Format(time.RFC3339),
		Source: Source{
			EnedisEndpoint:           enedis.Endpoint,
			GeocoderEndpoint:         geocode.PrimaryEndpoint,
			GeocoderFallbackEndpoint: geocode.FallbackEndpoint,
			StreetGeometryEndpoint:   streetgeom.PrimaryEndpoint,
		},
		Query:   query,
		Polygon: combinePolygons(polygons),
		Stats:   stats,
		Outages: outageList,
		Streets: streets,
		Recap:   recap,
		Crises:  crises,
	}
	if len(queries) > 1 {
		response.Queries = queries
	}
	return response
}

func (n *Normalizer) geocodeStreets(ctx context.Context, streets []Street) {
	jobs := make(chan int)
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		for index := range jobs {
			query := strings.TrimSpace(strings.Join([]string{
				streets[index].NormalizedName,
				streets[index].City,
				streets[index].Postcode,
			}, " "))
			result := n.geocoder.Street(ctx, query)
			streets[index].Geocode = &result
			if !result.Cached {
				time.Sleep(120 * time.Millisecond)
			}
		}
	}()

	for index := range streets {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
}

func (n *Normalizer) attachStreetGeometry(ctx context.Context, streets []Street, geometryBounds *geo.Bounds) {
	if n.geometries == nil {
		return
	}

	requests := make([]streetgeom.Request, 0, len(streets))
	for _, street := range streets {
		request := streetgeom.Request{
			ID:   street.Key,
			Name: street.NormalizedName,
		}
		if street.Geocode != nil && street.Geocode.Status == "ok" {
			request.Point = &streetgeom.Point{Lat: street.Geocode.Lat, Lng: street.Geocode.Lng}
		}
		requests = append(requests, request)
	}

	var results map[string]streetgeom.Result
	if geometryBounds != nil {
		if bounded, ok := n.geometries.(PointAwareBoundedGeometryProvider); ok {
			results = bounded.StreetRequestsInBounds(ctx, requests, *geometryBounds)
		} else if bounded, ok := n.geometries.(BoundedGeometryProvider); ok {
			results = bounded.StreetsInBounds(ctx, requestNames(requests), *geometryBounds)
		}
	}
	if results == nil {
		if pointAware, ok := n.geometries.(PointAwareGeometryProvider); ok {
			results = pointAware.StreetRequests(ctx, requests)
		} else {
			results = n.geometries.Streets(ctx, requestNames(requests))
		}
	}
	for index := range streets {
		result, ok := results[streets[index].Key]
		if !ok {
			key := streetgeom.Key(streets[index].NormalizedName)
			result, ok = results[key]
		}
		if !ok {
			continue
		}
		streets[index].Geometry = &result
	}
}

func requestNames(requests []streetgeom.Request) []string {
	names := make([]string, 0, len(requests))
	for _, request := range requests {
		names = append(names, request.Name)
	}
	return names
}

func parseLocalisation(localisation, fallbackCity string) parsedStreet {
	parts := strings.SplitN(localisation, ",", 2)
	rawStreet := strings.TrimSpace(parts[0])
	rawCity := fallbackCity
	if len(parts) > 1 {
		rawCity = strings.TrimSpace(parts[1])
	}

	postcode := ""
	if match := regexp.MustCompile(`\((\d{5})\)`).FindStringSubmatch(rawCity); len(match) == 2 {
		postcode = match[1]
	} else if match := regexp.MustCompile(`\b(75\d{3})\b`).FindStringSubmatch(rawStreet); len(match) == 2 {
		postcode = match[1]
	}

	city := regexp.MustCompile(`\([^)]*\)`).ReplaceAllString(rawCity, "")
	city = strings.TrimSpace(city)
	if city == "" {
		city = fallbackCity
	}
	if city == "" {
		city = "Paris"
	}

	normalizedName := normalizeStreet(rawStreet)
	return parsedStreet{
		Label:          titleCase(normalizedName),
		NormalizedName: normalizedName,
		NormalizedKey:  strings.ToUpper(stripAccents(normalizedName)),
		City:           titleCase(city),
		Postcode:       postcode,
	}
}

func normalizeStreet(input string) string {
	value := strings.ToUpper(stripAccents(input))
	value = strings.ReplaceAll(value, "\u00a0", " ")
	value = strings.NewReplacer("(", " ", ")", " ").Replace(value)
	value = regexp.MustCompile(`\s+`).ReplaceAllString(value, " ")
	value = strings.TrimSpace(value)

	replacements := []struct {
		pattern string
		replace string
	}{
		{`^/+\s*`, ``},
		{`^ET\s+`, ``},
		{`^PARKING\s+VINCI/ROSSINI\s+\d+\s+`, ``},
		{`^R[.\s]+`, `RUE `},
		{`^BD[.\s]+`, `BOULEVARD `},
		{`^BLD[.\s]+`, `BOULEVARD `},
		{`^AV(?:E)?[.\s]+`, `AVENUE `},
		{`^PL[.\s]+`, `PLACE `},
		{`^PAS[.\s]+`, `PASSAGE `},
		{`^IMP[.\s]+`, `IMPASSE `},
		{`^SQ[.\s]+`, `SQUARE `},
		{`\bFBG\b`, `FAUBOURG`},
		{`\bFG\b`, `FAUBOURG`},
		{`\bST\b`, `SAINT`},
		{`\bSTE\b`, `SAINTE`},
	}
	for _, item := range replacements {
		value = regexp.MustCompile(item.pattern).ReplaceAllString(value, item.replace)
		value = stripLeadingAddressNumber(value)
	}

	value = regexp.MustCompile(`\s+`).ReplaceAllString(value, " ")
	return strings.TrimSpace(value)
}

func stripLeadingAddressNumber(value string) string {
	cleaned := strings.TrimSpace(strings.TrimLeft(value, "/ "))
	match := regexp.MustCompile(`^\d+(?:[.\s]\d+)*[A-Z]?\s+(.+)$`).FindStringSubmatch(cleaned)
	if len(match) != 2 {
		return cleaned
	}
	rest := strings.TrimSpace(match[1])
	if looksLikeStreetName(rest) {
		return rest
	}
	return cleaned
}

func looksLikeStreetName(value string) bool {
	prefixes := []string{
		"RUE ", "R. ", "R ", "BD ", "BLD ", "BOULEVARD ", "AV ", "AVE ", "AVENUE ",
		"PL ", "PLACE ", "PAS ", "PASSAGE ", "IMP ", "IMPASSE ", "SQ ", "SQUARE ",
		"VILLA ", "CITE ", "EGLISE ",
	}
	for _, prefix := range prefixes {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
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

func titleCase(value string) string {
	smallWords := map[string]bool{
		"a": true, "au": true, "aux": true, "d": true, "de": true, "des": true,
		"du": true, "et": true, "l": true, "la": true, "le": true, "les": true,
	}

	words := strings.Fields(strings.ToLower(value))
	for index, word := range words {
		if index > 0 && smallWords[word] {
			continue
		}
		words[index] = capitalize(word)
	}
	return strings.Join(words, " ")
}

func capitalize(value string) string {
	runes := []rune(value)
	if len(runes) == 0 {
		return value
	}
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

func earliestFrenchDate(current, candidate string) string {
	if candidate == "" {
		return current
	}
	if current == "" || parseFrenchDate(candidate).Before(parseFrenchDate(current)) {
		return candidate
	}
	return current
}

func latestFrenchDate(current, candidate string) string {
	if candidate == "" {
		return current
	}
	if current == "" || parseFrenchDate(candidate).After(parseFrenchDate(current)) {
		return candidate
	}
	return current
}

func parseFrenchDate(value string) time.Time {
	parsed, err := time.ParseInLocation("02/01/2006 15:04", value, time.Local)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func combinePolygons(polygons []json.RawMessage) json.RawMessage {
	if len(polygons) == 0 {
		return nil
	}
	if len(polygons) == 1 {
		return polygons[0]
	}

	features := []json.RawMessage{}
	for _, polygon := range polygons {
		if len(polygon) == 0 || string(polygon) == "null" {
			continue
		}

		var decoded struct {
			Type     string            `json:"type"`
			Features []json.RawMessage `json:"features"`
		}
		if err := json.Unmarshal(polygon, &decoded); err != nil {
			continue
		}

		switch decoded.Type {
		case "FeatureCollection":
			features = append(features, decoded.Features...)
		case "Feature":
			features = append(features, polygon)
		default:
			feature, err := json.Marshal(struct {
				Type       string          `json:"type"`
				Geometry   json.RawMessage `json:"geometry"`
				Properties map[string]any  `json:"properties"`
			}{
				Type:       "Feature",
				Geometry:   polygon,
				Properties: map[string]any{},
			})
			if err == nil {
				features = append(features, feature)
			}
		}
	}
	if len(features) == 0 {
		return nil
	}

	combined, err := json.Marshal(struct {
		Type     string            `json:"type"`
		Features []json.RawMessage `json:"features"`
	}{
		Type:     "FeatureCollection",
		Features: features,
	})
	if err != nil {
		return nil
	}
	return combined
}

func addUnique(values *[]string, value string) {
	if value == "" {
		return
	}
	for _, existing := range *values {
		if existing == value {
			return
		}
	}
	*values = append(*values, value)
}

func addUniqueAddress(addresses *[]enedis.Address, address enedis.Address) {
	for _, existing := range *addresses {
		if existing == address {
			return
		}
	}
	*addresses = append(*addresses, address)
}

func fallback(value, fallbackValue string) string {
	if value == "" {
		return fallbackValue
	}
	return value
}
