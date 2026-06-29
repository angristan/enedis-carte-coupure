package geo

import (
	"net/url"
	"testing"
)

func TestParseBoundsFromNamedValues(t *testing.T) {
	values := url.Values{
		"south": {"48.8"},
		"west":  {"2.2"},
		"north": {"48.9"},
		"east":  {"2.4"},
	}

	bounds, ok, err := ParseBounds(values)
	if err != nil {
		t.Fatalf("ParseBounds returned error: %v", err)
	}
	if !ok {
		t.Fatal("ParseBounds did not detect bounds")
	}
	if bounds.South != 48.8 || bounds.West != 2.2 || bounds.North != 48.9 || bounds.East != 2.4 {
		t.Fatalf("unexpected bounds: %+v", bounds)
	}
}

func TestParseBoundsFromBBox(t *testing.T) {
	values := url.Values{"bbox": {"2.2,48.8,2.4,48.9"}}

	bounds, ok, err := ParseBounds(values)
	if err != nil {
		t.Fatalf("ParseBounds returned error: %v", err)
	}
	if !ok {
		t.Fatal("ParseBounds did not detect bounds")
	}
	if bounds.South != 48.8 || bounds.West != 2.2 || bounds.North != 48.9 || bounds.East != 2.4 {
		t.Fatalf("unexpected bounds: %+v", bounds)
	}
}

func TestParseBoundsRejectsPartialBounds(t *testing.T) {
	_, ok, err := ParseBounds(url.Values{"south": {"48.8"}})
	if !ok {
		t.Fatal("ParseBounds should detect a partial bounds request")
	}
	if err == nil {
		t.Fatal("ParseBounds should reject partial bounds")
	}
}
