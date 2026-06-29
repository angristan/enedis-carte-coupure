package geo

import (
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
)

type Bounds struct {
	South float64 `json:"south"`
	West  float64 `json:"west"`
	North float64 `json:"north"`
	East  float64 `json:"east"`
}

func ParseBounds(values url.Values) (Bounds, bool, error) {
	if bbox := strings.TrimSpace(values.Get("bbox")); bbox != "" {
		parts := strings.Split(bbox, ",")
		if len(parts) != 4 {
			return Bounds{}, true, fmt.Errorf("bbox must be west,south,east,north")
		}
		west, err := parseFloat(parts[0], "bbox west")
		if err != nil {
			return Bounds{}, true, err
		}
		south, err := parseFloat(parts[1], "bbox south")
		if err != nil {
			return Bounds{}, true, err
		}
		east, err := parseFloat(parts[2], "bbox east")
		if err != nil {
			return Bounds{}, true, err
		}
		north, err := parseFloat(parts[3], "bbox north")
		if err != nil {
			return Bounds{}, true, err
		}
		return normalizeAndValidate(Bounds{South: south, West: west, North: north, East: east})
	}

	if !values.Has("south") && !values.Has("west") && !values.Has("north") && !values.Has("east") {
		return Bounds{}, false, nil
	}
	for _, name := range []string{"south", "west", "north", "east"} {
		if !values.Has(name) {
			return Bounds{}, true, fmt.Errorf("missing %s", name)
		}
	}

	south, err := parseFloat(values.Get("south"), "south")
	if err != nil {
		return Bounds{}, true, err
	}
	west, err := parseFloat(values.Get("west"), "west")
	if err != nil {
		return Bounds{}, true, err
	}
	north, err := parseFloat(values.Get("north"), "north")
	if err != nil {
		return Bounds{}, true, err
	}
	east, err := parseFloat(values.Get("east"), "east")
	if err != nil {
		return Bounds{}, true, err
	}
	return normalizeAndValidate(Bounds{South: south, West: west, North: north, East: east})
}

func (b Bounds) Center() Point {
	return Point{
		Lat: (b.South + b.North) / 2,
		Lng: (b.West + b.East) / 2,
	}
}

func (b Bounds) Height() float64 {
	return b.North - b.South
}

func (b Bounds) Width() float64 {
	return b.East - b.West
}

func (b Bounds) Area() float64 {
	return b.Height() * b.Width()
}

func (b Bounds) Padded(ratio float64) Bounds {
	if ratio <= 0 {
		return b
	}
	latPad := b.Height() * ratio
	lngPad := b.Width() * ratio
	return Bounds{
		South: clampLatitude(b.South - latPad),
		West:  clampLongitude(b.West - lngPad),
		North: clampLatitude(b.North + latPad),
		East:  clampLongitude(b.East + lngPad),
	}
}

func (b Bounds) Snapped(grid float64) Bounds {
	if grid <= 0 {
		return b
	}
	return Bounds{
		South: clampLatitude(math.Floor(b.South/grid) * grid),
		West:  clampLongitude(math.Floor(b.West/grid) * grid),
		North: clampLatitude(math.Ceil(b.North/grid) * grid),
		East:  clampLongitude(math.Ceil(b.East/grid) * grid),
	}
}

func (b Bounds) CacheKey() string {
	return fmt.Sprintf("%.4f,%.4f,%.4f,%.4f", b.South, b.West, b.North, b.East)
}

func (b Bounds) OverpassBBox() string {
	return fmt.Sprintf("%.6f,%.6f,%.6f,%.6f", b.South, b.West, b.North, b.East)
}

type Point struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

func normalizeAndValidate(bounds Bounds) (Bounds, bool, error) {
	if bounds.South > bounds.North {
		bounds.South, bounds.North = bounds.North, bounds.South
	}
	if bounds.West > bounds.East {
		return Bounds{}, true, fmt.Errorf("bounds crossing the antimeridian are not supported")
	}
	for name, value := range map[string]float64{
		"south": bounds.South,
		"north": bounds.North,
	} {
		if value < -90 || value > 90 {
			return Bounds{}, true, fmt.Errorf("%s must be between -90 and 90", name)
		}
	}
	for name, value := range map[string]float64{
		"west": bounds.West,
		"east": bounds.East,
	} {
		if value < -180 || value > 180 {
			return Bounds{}, true, fmt.Errorf("%s must be between -180 and 180", name)
		}
	}
	if bounds.Height() <= 0 || bounds.Width() <= 0 {
		return Bounds{}, true, fmt.Errorf("bounds must have a positive area")
	}
	return bounds, true, nil
}

func parseFloat(value, name string) (float64, error) {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s", name)
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, fmt.Errorf("invalid %s", name)
	}
	return parsed, nil
}

func clampLatitude(value float64) float64 {
	return math.Max(-90, math.Min(90, value))
}

func clampLongitude(value float64) float64 {
	return math.Max(-180, math.Min(180, value))
}
