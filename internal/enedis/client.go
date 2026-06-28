package enedis

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

const (
	Origin      = "https://www.enedis.fr"
	Endpoint    = Origin + "/panne-interruption-ajax"
	ResultPage  = Origin + "/resultat-panne-interruption"
	defaultLong = "2.347"
	defaultLat  = "48.859"
	defaultDept = "75"
)

var DefaultQuery = Query{
	Insee:    "75056",
	Type:     "municipality",
	Adresse:  "Paris",
	CPVille:  "Paris 75001",
	Name:     "Paris",
	District: "",
	City:     "Paris",
}

type Client struct {
	httpClient *http.Client
}

type Query struct {
	Insee    string `json:"insee"`
	Type     string `json:"type"`
	Adresse  string `json:"adresse"`
	CPVille  string `json:"CPVille"`
	Name     string `json:"name"`
	District string `json:"district"`
	City     string `json:"city"`
}

type Response struct {
	Polygon         json.RawMessage `json:"polygon"`
	ResultMegacache ResultMegacache `json:"resultMegacache"`
	BigData         string          `json:"bigData"`
}

type ResultMegacache struct {
	CodeRetour              int             `json:"codeRetour"`
	CompteurBT              int             `json:"compteurBT"`
	CompteurIncidentHTA     int             `json:"compteurIncidentHTA"`
	CompteurTravauxHTA      int             `json:"compteurTravauxHTA"`
	ListeCoupuresInfoReseau []Outage        `json:"listeCoupuresInfoReseau"`
	ListeCrises             json.RawMessage `json:"listeCrises"`
	Recap                   json.RawMessage `json:"recap"`
}

type Outage struct {
	CoupureClose       bool      `json:"coupureClose"`
	ListeAdresses      []Address `json:"listeAdresses"`
	IDCoupure          string    `json:"idCoupure"`
	EtatCoupure        string    `json:"etatCoupure"`
	DateRealimentation string    `json:"dateRealimentation"`
	DateCoupure        string    `json:"dateCoupure"`
	IncidentCoupure    string    `json:"incidentCoupure"`
	NbFoyersCoupes     int       `json:"nbFoyersCoupes"`
	EtatElectrique     int       `json:"etatElectrique"`
	CodeInsee          string    `json:"codeInsee"`
}

type Address struct {
	Localisation   string `json:"localisation"`
	NbFoyersCoupes int    `json:"nbFoyersCoupes"`
}

func NewClient(httpClient *http.Client) *Client {
	return &Client{httpClient: httpClient}
}

func QueryFromValues(values url.Values) Query {
	query := DefaultQuery
	if values.Has("insee") {
		query.Insee = values.Get("insee")
	}
	if values.Has("type") {
		query.Type = values.Get("type")
	}
	if values.Has("adresse") {
		query.Adresse = values.Get("adresse")
	}
	if values.Has("CPVille") {
		query.CPVille = values.Get("CPVille")
	}
	if values.Has("name") {
		query.Name = values.Get("name")
	}
	if values.Has("district") {
		query.District = values.Get("district")
	}
	if values.Has("city") {
		query.City = values.Get("city")
	}
	return query
}

func (c *Client) Fetch(ctx context.Context, query Query) (json.RawMessage, Response, error) {
	endpoint, _ := url.Parse(Endpoint)
	params := endpoint.Query()
	params.Set("insee", query.Insee)
	params.Set("type", query.Type)
	params.Set("adresse", query.Adresse)
	params.Set("CPVille", query.CPVille)
	params.Set("name", query.Name)
	params.Set("district", query.District)
	params.Set("city", query.City)
	endpoint.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, Response{}, err
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Referer", resultURL(query))
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, Response{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, Response{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, Response{}, fmt.Errorf("Enedis returned %s: %s", resp.Status, string(body[:min(len(body), 180)]))
	}

	var decoded Response
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, Response{}, fmt.Errorf("decode Enedis JSON: %w", err)
	}
	return body, decoded, nil
}

func resultURL(query Query) string {
	ref, _ := url.Parse(ResultPage)
	params := ref.Query()
	params.Set("adresse", query.Adresse)
	params.Set("insee", query.Insee)
	params.Set("long", defaultLong)
	params.Set("lat", defaultLat)
	params.Set("type", query.Type)
	params.Set("CPVille", query.CPVille)
	params.Set("street", "")
	params.Set("name", query.Name)
	params.Set("departement", defaultDept)
	params.Set("district", query.District)
	params.Set("city", query.City)
	ref.RawQuery = params.Encode()
	return ref.String()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
