package streetgeom

import "testing"

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
