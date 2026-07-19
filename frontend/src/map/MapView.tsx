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
  type MapLayerMouseEvent,
  type MapRef,
  NavigationControl,
  Popup,
  Source,
} from "react-map-gl/maplibre";
import type { OutageResponse, Street } from "../../../shared/api.js";
import { StreetPopup } from "../components/SidePanel.js";
import { decodeAreaFeatureCollection } from "./areaFeatures.js";
import {
  INITIAL_VIEW_STATE,
  MAP_STYLE_URL,
  OUTAGE_AREA_SOURCE_ID,
  OUTAGE_STREET_SOURCE_ID,
  POLYGON_FILL_LAYER,
  POLYGON_LINE_LAYER,
  STREET_CASING_LAYER,
  STREET_LINE_LAYER,
  STREET_LINE_LAYER_ID,
  STREET_POINT_LAYER,
  STREET_POINT_LAYER_ID,
} from "./layers.js";
import { streetFeatureCollection } from "./streetFeatures.js";
import { streetBounds } from "./streetLines.js";
import { type Viewport, viewportFromMap } from "./viewport.js";

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

    if (
      map?.getSource(OUTAGE_STREET_SOURCE_ID) &&
      hoveredKeyRef.current.length > 0
    ) {
      map.setFeatureState({
        source: OUTAGE_STREET_SOURCE_ID,
        id: hoveredKeyRef.current,
      }, { hovered: false });
    }

    hoveredKeyRef.current = "";
    setHover(null);
  }, []);

  const setHoveredStreet = useCallback((streetKey: string) => {
    const map = mapRef.current?.getMap();

    if (
      !map?.getSource(OUTAGE_STREET_SOURCE_ID) ||
      hoveredKeyRef.current === streetKey
    ) return;

    if (hoveredKeyRef.current.length > 0) {
      map.setFeatureState({
        source: OUTAGE_STREET_SOURCE_ID,
        id: hoveredKeyRef.current,
      }, { hovered: false });
    }

    hoveredKeyRef.current = streetKey;

    if (streetKey.length > 0) {
      map.setFeatureState({
        source: OUTAGE_STREET_SOURCE_ID,
        id: streetKey,
      }, { hovered: true });
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
        { layers: [STREET_LINE_LAYER_ID, STREET_POINT_LAYER_ID] },
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
        initialViewState={INITIAL_VIEW_STATE}
        mapStyle={MAP_STYLE_URL}
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
            <Source
              id={OUTAGE_AREA_SOURCE_ID}
              type="geojson"
              data={areaGeoJson}
            >
              <Layer {...POLYGON_FILL_LAYER} />
              <Layer {...POLYGON_LINE_LAYER} />
            </Source>
          )
          : null}
        <Source
          id={OUTAGE_STREET_SOURCE_ID}
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

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function mapPadding(): number {
  return window.matchMedia("(max-width: 640px)").matches ? 30 : 64;
}
