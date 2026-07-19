import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import MapGL, {
  Layer,
  type LayerProps,
  type MapLayerMouseEvent,
  type MapRef,
  NavigationControl,
  Popup,
  Source,
} from "react-map-gl/maplibre";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { Option, Schema } from "effect";
import type { OutageResponse, Street } from "../../../shared/api.js";
import { StreetPopup } from "../components/SidePanel.js";
import { streetBounds, streetFeatureCollection } from "./geometry.js";
import { type Viewport, viewportFromMap } from "./viewport.js";

const INITIAL_CENTER = { latitude: 48.8566, longitude: 2.3522 };
const INITIAL_ZOOM = 12;
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const OUTAGE_SOURCE_ID = "outage-streets";

export interface MapViewHandle {
  focusStreet(streetKey: string): void;
}

interface MapViewProps {
  readonly data: OutageResponse | null;
  readonly streets: ReadonlyArray<Street>;
  readonly activeKey: string;
  readonly onInteractionStart: () => void;
  readonly onSelectStreet: (streetKey: string) => void;
  readonly onViewportChange: (viewport: Viewport) => void;
}

interface HoverLabel {
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

interface StreetPopupState {
  readonly street: Street;
  readonly longitude: number;
  readonly latitude: number;
}

const POLYGON_FILL_LAYER: LayerProps = {
  id: "outage-area-fill",
  type: "fill",
  paint: { "fill-color": "#5db79e", "fill-opacity": 0.07 },
};

const POLYGON_LINE_LAYER: LayerProps = {
  id: "outage-area-line",
  type: "line",
  paint: { "line-color": "#277783", "line-width": 1.3, "line-opacity": 0.65 },
};

const STREET_CASING_LAYER: LayerProps = {
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

const STREET_LINE_LAYER: LayerProps = {
  id: "outage-street-line",
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

const STREET_POINT_LAYER: LayerProps = {
  id: "outage-street-point",
  type: "circle",
  filter: ["==", ["geometry-type"], "Point"],
  paint: {
    "circle-color": ["get", "color"],
    "circle-opacity": 0.86,
    "circle-radius": ["+", ["get", "radius"], [
      "case",
      ["boolean", ["get", "selected"], false],
      2,
      0,
    ]],
    "circle-stroke-color": "#ffffff",
    "circle-stroke-opacity": 0.96,
    "circle-stroke-width": 3,
  },
};

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  {
    data,
    streets,
    activeKey,
    onInteractionStart,
    onSelectStreet,
    onViewportChange,
  },
  ref,
) {
  const mapRef = useRef<MapRef>(null);
  const hoveredKeyRef = useRef("");
  const streetByKey = useMemo(
    () => new Map(streets.map((street) => [street.key, street])),
    [streets],
  );
  const outageGeoJson = useMemo(
    () => streetFeatureCollection(streets, activeKey),
    [activeKey, streets],
  );
  const areaGeoJson = useMemo(
    () => decodeAreaFeatureCollection(data?.polygon),
    [data?.polygon],
  );
  const [hover, setHover] = useState<HoverLabel | null>(null);
  const [popup, setPopup] = useState<StreetPopupState | null>(null);

  const clearHover = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (map?.getSource(OUTAGE_SOURCE_ID) && hoveredKeyRef.current.length > 0) {
      map.setFeatureState({
        source: OUTAGE_SOURCE_ID,
        id: hoveredKeyRef.current,
      }, { hovered: false });
    }
    hoveredKeyRef.current = "";
    setHover(null);
  }, []);

  const setHoveredStreet = useCallback((streetKey: string) => {
    const map = mapRef.current?.getMap();
    if (
      !map?.getSource(OUTAGE_SOURCE_ID) || hoveredKeyRef.current === streetKey
    ) return;
    if (hoveredKeyRef.current.length > 0) {
      map.setFeatureState({
        source: OUTAGE_SOURCE_ID,
        id: hoveredKeyRef.current,
      }, { hovered: false });
    }
    hoveredKeyRef.current = streetKey;
    if (streetKey.length > 0) {
      map.setFeatureState({ source: OUTAGE_SOURCE_ID, id: streetKey }, {
        hovered: true,
      });
    }
  }, []);

  useImperativeHandle(ref, () => ({
    focusStreet(streetKey: string): void {
      const map = mapRef.current?.getMap();
      const street = streetByKey.get(streetKey);
      if (map === undefined || street === undefined) return;
      const bounds = streetBounds(street);
      if (bounds === undefined) return;
      map.fitBounds(
        [[bounds.west, bounds.south], [bounds.east, bounds.north]],
        { padding: mapPadding(), maxZoom: 17.5, duration: 620 },
      );
      setPopup({
        street,
        longitude: (bounds.west + bounds.east) / 2,
        latitude: (bounds.south + bounds.north) / 2,
      });
    },
  }), [streetByKey]);

  const findStreetFeature = useCallback(
    (event: MapLayerMouseEvent, radius: number) => {
      const map = mapRef.current?.getMap();
      if (map === undefined) return undefined;
      const { x, y } = event.point;
      return map.queryRenderedFeatures(
        [[x - radius, y - radius], [x + radius, y + radius]],
        { layers: ["outage-street-line", "outage-street-point"] },
      )[0];
    },
    [],
  );

  const handlePointerMove = useCallback((event: MapLayerMouseEvent) => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const feature = findStreetFeature(event, 6);
    const streetKey = stringValue(feature?.id ?? feature?.properties.key);
    if (streetKey.length === 0) {
      clearHover();
      return;
    }
    setHoveredStreet(streetKey);
    setHover({
      label: stringValue(feature?.properties.label),
      x: event.point.x,
      y: event.point.y - 10,
    });
  }, [clearHover, findStreetFeature, setHoveredStreet]);

  const handleMapClick = useCallback((event: MapLayerMouseEvent) => {
    const feature = findStreetFeature(event, 10);
    const streetKey = stringValue(feature?.id ?? feature?.properties.key);
    const street = streetByKey.get(streetKey);
    if (street === undefined) return;
    onSelectStreet(streetKey);
    setPopup({
      street,
      longitude: event.lngLat.lng,
      latitude: event.lngLat.lat,
    });
  }, [findStreetFeature, onSelectStreet, streetByKey]);

  const handleInteractionStart = useCallback(() => {
    clearHover();
    setPopup(null);
    onInteractionStart();
  }, [clearHover, onInteractionStart]);

  return (
    <div className="map-canvas-shell">
      <MapGL
        ref={mapRef}
        cursor={hover === null ? undefined : "pointer"}
        dragRotate={false}
        initialViewState={{ ...INITIAL_CENTER, zoom: INITIAL_ZOOM }}
        mapStyle={MAP_STYLE}
        maxPitch={0}
        maxZoom={19}
        minZoom={4}
        onClick={handleMapClick}
        onLoad={(event) => onViewportChange(viewportFromMap(event.target))}
        onMouseLeave={clearHover}
        onMouseMove={handlePointerMove}
        onMoveEnd={(event) => onViewportChange(viewportFromMap(event.target))}
        onMoveStart={handleInteractionStart}
        pitchWithRotate={false}
        reuseMaps
        style={{ width: "100%", height: "100%" }}
        touchPitch={false}
      >
        <NavigationControl position="bottom-left" showCompass={false} />
        {areaGeoJson !== undefined && areaGeoJson.features.length > 0
          ? (
            <Source id="outage-area" type="geojson" data={areaGeoJson}>
              <Layer {...POLYGON_FILL_LAYER} />
              <Layer {...POLYGON_LINE_LAYER} />
            </Source>
          )
          : null}
        <Source
          id={OUTAGE_SOURCE_ID}
          type="geojson"
          data={outageGeoJson}
          promoteId="key"
        >
          <Layer {...STREET_CASING_LAYER} />
          <Layer {...STREET_LINE_LAYER} />
          <Layer {...STREET_POINT_LAYER} />
        </Source>
        {popup === null ? null : (
          <Popup
            anchor="bottom"
            closeButton
            closeOnClick={false}
            latitude={popup.latitude}
            longitude={popup.longitude}
            maxWidth="320px"
            offset={12}
            onClose={() => setPopup(null)}
          >
            <StreetPopup street={popup.street} />
          </Popup>
        )}
      </MapGL>
      {hover === null ? null : (
        <div
          className="map-hover-label"
          style={{ left: hover.x, top: hover.y }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
});

const PositionSchema = Schema.Array(Schema.Number);
const PolygonSchema = Schema.Struct({
  type: Schema.Literal("Polygon"),
  coordinates: Schema.Array(Schema.Array(PositionSchema)),
});
const MultiPolygonSchema = Schema.Struct({
  type: Schema.Literal("MultiPolygon"),
  coordinates: Schema.Array(Schema.Array(Schema.Array(PositionSchema))),
});
const AreaFeatureCollectionSchema = Schema.Struct({
  type: Schema.Literal("FeatureCollection"),
  features: Schema.Array(Schema.Struct({
    type: Schema.Literal("Feature"),
    geometry: Schema.Union([PolygonSchema, MultiPolygonSchema]),
    properties: Schema.optionalKey(Schema.Unknown),
  })),
});
const decodeArea = Schema.decodeUnknownOption(AreaFeatureCollectionSchema);

type AreaFeatureCollection = FeatureCollection<Polygon | MultiPolygon>;

function decodeAreaFeatureCollection(
  input: unknown,
): AreaFeatureCollection | undefined {
  const decoded = decodeArea(input);
  if (Option.isNone(decoded)) return undefined;
  return {
    type: "FeatureCollection",
    features: decoded.value.features.map((feature) => ({
      type: "Feature",
      properties: objectOrEmpty(feature.properties),
      geometry: feature.geometry.type === "Polygon"
        ? {
          type: "Polygon",
          coordinates: feature.geometry.coordinates.map(copyRings),
        }
        : {
          type: "MultiPolygon",
          coordinates: feature.geometry.coordinates.map((polygon) =>
            polygon.map(copyRings)
          ),
        },
    })),
  };
}

function copyRings(
  ring: ReadonlyArray<ReadonlyArray<number>>,
): Array<Array<number>> {
  return ring.map((position) => [...position]);
}

function objectOrEmpty(value: unknown): object {
  return typeof value === "object" && value !== null ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function mapPadding(): number {
  return window.matchMedia("(max-width: 640px)").matches ? 30 : 64;
}
