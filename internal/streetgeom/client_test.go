package streetgeom

import (
	"regexp"
	"strings"
	"testing"
)

func TestKeyNormalizesOSMAndEnedisStreetNames(t *testing.T) {
	cases := map[string]string{
		"Boulevard Saint-Germain":      "BOULEVARD SAINT GERMAIN",
		"BOULEVARD SAINT GERMAIN":      "BOULEVARD SAINT GERMAIN",
		"Rue du Faubourg Saint-Honoré": "RUE DU FAUBOURG SAINT HONORE",
		"R. de Turenne":                "RUE DE TURENNE",
	}

	for input, expected := range cases {
		if got := Key(input); got != expected {
			t.Fatalf("Key(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestFilterResultNearPointKeepsClosestSameNameComponent(t *testing.T) {
	result := Result{
		Status: "ok",
		Query:  "Avenue Victor Hugo",
		Lines: [][]Point{
			{
				{Lat: 48.8690, Lng: 2.2840},
				{Lat: 48.8700, Lng: 2.2850},
			},
			{
				{Lat: 48.8700, Lng: 2.2850},
				{Lat: 48.8710, Lng: 2.2860},
			},
			{
				{Lat: 48.8350, Lng: 2.2400},
				{Lat: 48.8360, Lng: 2.2410},
			},
		},
	}

	filtered := filterResultNearPoint(result, Point{Lat: 48.8702, Lng: 2.2851})
	if filtered.Status != "ok" {
		t.Fatalf("filtered status = %q, want ok", filtered.Status)
	}
	if got, want := len(filtered.Lines), 2; got != want {
		t.Fatalf("filtered lines = %d, want %d", got, want)
	}
}

func TestNameRegexFromKeyMatchesAccentedOSMName(t *testing.T) {
	pattern := `(?i)^ *(` + nameRegexFromKey("AVENUE DE L OPERA") + `) *$`
	if !regexp.MustCompile(pattern).MatchString("Avenue de l'Opéra") {
		t.Fatalf("pattern %q should match accented OSM name", pattern)
	}
}

func TestBuildLookupQueryFiltersRequestedStreetNames(t *testing.T) {
	query := buildLookupQuery(defaultBounds(), []string{"AVENUE VICTOR HUGO", "RUE DE RIVOLI"})
	if !strings.Contains(query, `["name"~`) {
		t.Fatalf("query should filter by OSM name: %s", query)
	}
	if strings.Contains(query, `way["highway"]["name"](`) {
		t.Fatalf("query should not fetch every named road: %s", query)
	}
}
