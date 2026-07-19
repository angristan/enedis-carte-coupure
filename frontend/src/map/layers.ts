import type { LayerProps } from "react-map-gl/maplibre";

export const INITIAL_VIEW_STATE = {
  latitude: 48.8566,
  longitude: 2.3522,
  zoom: 12,
};

export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
export const OUTAGE_AREA_SOURCE_ID = "outage-area";
export const OUTAGE_STREET_SOURCE_ID = "outage-streets";
export const STREET_LINE_LAYER_ID = "outage-street-line";
export const STREET_POINT_LAYER_ID = "outage-street-point";

export const POLYGON_FILL_LAYER: LayerProps = {
  id: "outage-area-fill",
  type: "fill",
  paint: { "fill-color": "#5db79e", "fill-opacity": 0.07 },
};

export const POLYGON_LINE_LAYER: LayerProps = {
  id: "outage-area-line",
  type: "line",
  paint: { "line-color": "#277783", "line-width": 1.3, "line-opacity": 0.65 },
};

export const STREET_CASING_LAYER: LayerProps = {
  id: "outage-street-casing",
  type: "line",
  filter: ["==", ["geometry-type"], "LineString"],
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-color": "#fffdf7",
    "line-opacity": [
      "case",
      ["boolean", ["feature-state", "hovered"], false],
      0.98,
      0.86,
    ],
    "line-width": [
      "+",
      ["get", "lineWidth"],
      [
        "case",
        ["boolean", ["get", "selected"], false],
        5.4,
        ["boolean", ["feature-state", "hovered"], false],
        5.4,
        4.2,
      ],
    ],
  },
};

export const STREET_LINE_LAYER: LayerProps = {
  id: STREET_LINE_LAYER_ID,
  type: "line",
  filter: ["==", ["geometry-type"], "LineString"],
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-color": ["get", "color"],
    "line-opacity": 0.94,
    "line-width": [
      "+",
      ["get", "lineWidth"],
      [
        "case",
        ["boolean", ["get", "selected"], false],
        1.8,
        ["boolean", ["feature-state", "hovered"], false],
        1.8,
        0,
      ],
    ],
  },
};

export const STREET_POINT_LAYER: LayerProps = {
  id: STREET_POINT_LAYER_ID,
  type: "circle",
  filter: ["==", ["geometry-type"], "Point"],
  paint: {
    "circle-color": ["get", "color"],
    "circle-opacity": 0.86,
    "circle-radius": [
      "+",
      ["get", "radius"],
      ["case", ["boolean", ["get", "selected"], false], 2, 0],
    ],
    "circle-stroke-color": "#ffffff",
    "circle-stroke-opacity": 0.96,
    "circle-stroke-width": 3,
  },
};
