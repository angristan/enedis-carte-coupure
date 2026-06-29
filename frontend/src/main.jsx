import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  AlertTriangle,
  Clock3,
  Loader2,
  MapPinned,
  RadioTower,
  RotateCw,
  Search,
  Zap,
} from "lucide-react";
import "./styles.css";

const MIN_FETCH_ZOOM = 11;
const FETCH_DEBOUNCE_MS = 650;
const INITIAL_CENTER = [48.8566, 2.3522];
const INITIAL_ZOOM = 12;

function App() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("Chargement des coupures dans la vue...");
  const [cacheStatus, setCacheStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [viewport, setViewport] = useState(null);

  const abortRef = useRef(null);
  const dataRef = useLatest(data);
  const viewportRef = useLatest(viewport);
  const lastLoadedKeyRef = useRef("");
  const mapRef = useRef(null);
  const listRef = useRef(null);

  const loadViewport = useCallback(
    async (nextViewport, { force = false } = {}) => {
      if (!nextViewport) return;

      if (nextViewport.zoom < MIN_FETCH_ZOOM) {
        abortRef.current?.abort();
        setLoading(false);
        setData(null);
        setCacheStatus("");
        setStatus("Zoomez pour charger les coupures dans la vue.");
        return;
      }

      const request = viewportRequest(nextViewport.bounds);
      if (!force && request.key === lastLoadedKeyRef.current && dataRef.current) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setStatus("Chargement des coupures dans la vue...");

      try {
        const response = await fetch(`/api/outages?${request.params}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        const responseCacheStatus = response.headers.get("X-App-Cache") || "";
        if (!response.ok) throw new Error(await errorMessage(response));

        const payload = await response.json();
        setData(payload);
        setCacheStatus(responseCacheStatus);
        setStatus(buildStatusText(payload));
        lastLoadedKeyRef.current = request.key;
      } catch (error) {
        if (error.name !== "AbortError") {
          setData(null);
          setCacheStatus("");
          setStatus(`Erreur: ${error.message}`);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setLoading(false);
      }
    },
    [dataRef],
  );

  useEffect(() => {
    if (viewport) loadViewport(viewport);
  }, [loadViewport, viewport]);

  useEffect(() => {
    const selected = listRef.current?.querySelector(`[data-street-key="${CSS.escape(activeKey)}"]`);
    selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeKey]);

  const filteredStreets = useMemo(
    () => filterStreets(data?.streets || [], activeFilter, query),
    [activeFilter, data, query],
  );
  const stats = data?.stats || {};

  const handleInteractionStart = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleSelectStreet = useCallback((streetKey) => {
    setActiveKey(streetKey);
  }, []);

  const handleListSelect = useCallback((street) => {
    setActiveKey(street.key);
    mapRef.current?.focusStreet(street.key);
  }, []);

  const handleRefresh = useCallback(() => {
    loadViewport(viewportRef.current, { force: true });
  }, [loadViewport, viewportRef]);

  return (
    <main className="app-shell">
      <section className="map-pane" aria-label="Carte des rues touchées">
        <MapView
          ref={mapRef}
          data={data}
          streets={filteredStreets}
          activeKey={activeKey}
          onInteractionStart={handleInteractionStart}
          onSelectStreet={handleSelectStreet}
          onViewportChange={setViewport}
        />

        <header className="map-topbar">
          <div className="brand-panel">
            <span className={loading ? "status-dot loading" : "status-dot"} />
            <div className="brand-copy">
              <h1>Rues touchées Enedis</h1>
              <p>{status}</p>
            </div>
          </div>
          <div className="map-actions" aria-label="Actions">
            <button type="button" onClick={handleRefresh} title="Rafraîchir la vue" aria-label="Rafraîchir la vue">
              <RotateCw size={20} aria-hidden="true" className={loading ? "spin" : ""} />
            </button>
            <a
              href="https://github.com/angristan/enedis-carte-coupure"
              target="_blank"
              rel="noreferrer"
              title="Voir le repo GitHub"
              aria-label="Voir le repo GitHub"
            >
              <GitHubLogo />
            </a>
          </div>
        </header>

        <StatsStrip stats={stats} />
      </section>

      <aside className="side-pane" aria-label="Détails des coupures">
        <div className="side-header">
          <div>
            <p className="eyebrow">Vue active</p>
            <h2>{formatNumber(filteredStreets.length)} rues visibles</h2>
          </div>
          <CacheBadge cacheStatus={cacheStatus} loading={loading} />
        </div>

        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Recherche</span>
          <input
            value={query}
            type="search"
            placeholder="Rue, commune, incident"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <SegmentedFilter activeFilter={activeFilter} onChange={setActiveFilter} />

        <div className="insight-grid" aria-label="Résumé">
          <Insight icon={MapPinned} label="Communes" value={formatNumber(data?.communes?.length || data?.queries?.length)} />
          <Insight icon={Clock3} label="Mis à jour" value={formatTime(data?.updatedAt)} />
        </div>

        <Legend />

        <StreetList
          ref={listRef}
          activeKey={activeKey}
          streets={filteredStreets}
          onSelectStreet={handleListSelect}
        />
      </aside>
    </main>
  );
}

function GitHubLogo() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.08 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.93.43.37.81 1.1.81 2.22v3.3c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z"
      />
    </svg>
  );
}

const MapView = forwardRef(function MapView(
  { data, streets, activeKey, onInteractionStart, onSelectStreet, onViewportChange },
  ref,
) {
  const shellRef = useRef(null);
  const mapNodeRef = useRef(null);
  const mapRef = useRef(null);
  const rendererRef = useRef(null);
  const outageLayerRef = useRef(null);
  const polygonLayerRef = useRef(null);
  const layerByKeyRef = useRef(new Map());
  const activeKeyRef = useLatest(activeKey);
  const callbacksRef = useLatest({ onInteractionStart, onSelectStreet, onViewportChange });
  const [hover, setHover] = useState(null);

  useImperativeHandle(
    ref,
    () => ({
      focusStreet(streetKey) {
        const entry = layerByKeyRef.current.get(streetKey);
        if (!entry) return;
        focusEntry(mapRef.current, entry);
        window.setTimeout(() => entry.popupTarget?.openPopup(), 220);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!mapNodeRef.current) return undefined;

    const map = L.map(mapNodeRef.current, {
      zoomControl: false,
      easeLinearity: 0.22,
      inertia: true,
      inertiaDeceleration: 2600,
      inertiaMaxSpeed: 1600,
      markerZoomAnimation: false,
      preferCanvas: true,
      wheelDebounceTime: 24,
      wheelPxPerZoomLevel: 92,
      zoomAnimation: true,
      zoomDelta: 0.5,
      zoomSnap: 0.25,
    }).setView(INITIAL_CENTER, INITIAL_ZOOM);

    L.control.zoom({ position: "bottomleft" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    map.createPane("streetPane");
    map.getPane("streetPane").style.zIndex = 420;

    mapRef.current = map;
    rendererRef.current = L.canvas({ pane: "streetPane", padding: 0.55, tolerance: 8 });
    outageLayerRef.current = L.layerGroup().addTo(map);
    polygonLayerRef.current = L.layerGroup().addTo(map);

    let loadTimer = 0;
    const emitViewport = () => callbacksRef.current.onViewportChange?.(viewportFromMap(map));
    const scheduleViewportLoad = () => {
      window.clearTimeout(loadTimer);
      loadTimer = window.setTimeout(emitViewport, FETCH_DEBOUNCE_MS);
    };
    const beginInteraction = () => {
      window.clearTimeout(loadTimer);
      setHover(null);
      callbacksRef.current.onInteractionStart?.();
    };

    map.on("moveend", scheduleViewportLoad);
    map.on("movestart zoomstart popupopen", beginInteraction);
    window.setTimeout(emitViewport, 0);

    return () => {
      window.clearTimeout(loadTimer);
      map.remove();
      mapRef.current = null;
      rendererRef.current = null;
      outageLayerRef.current = null;
      polygonLayerRef.current = null;
      layerByKeyRef.current.clear();
    };
  }, [callbacksRef]);

  useEffect(() => {
    const map = mapRef.current;
    const outageLayer = outageLayerRef.current;
    const polygonLayer = polygonLayerRef.current;
    const renderer = rendererRef.current;
    if (!map || !outageLayer || !polygonLayer || !renderer) return;

    outageLayer.clearLayers();
    polygonLayer.clearLayers();
    layerByKeyRef.current.clear();
    setHover(null);

    if (data?.polygon?.features?.length) {
      L.geoJSON(data.polygon, {
        style: {
          color: "#277783",
          weight: 1.3,
          opacity: 0.65,
          fillColor: "#5db79e",
          fillOpacity: 0.07,
        },
        interactive: false,
      }).addTo(polygonLayer);
    }

    for (const street of streets) {
      const entry = createStreetEntry({
        street,
        renderer,
        activeKeyRef,
        mapShell: shellRef.current,
        onHover: setHover,
        onSelect: callbacksRef.current.onSelectStreet,
      });
      if (!entry) continue;
      entry.layer.addTo(outageLayer);
      layerByKeyRef.current.set(street.key, entry);
      applyStreetStyle(entry, activeKeyRef.current);
    }

    window.requestAnimationFrame(() => map.invalidateSize());
  }, [activeKeyRef, callbacksRef, data, streets]);

  useEffect(() => {
    for (const entry of layerByKeyRef.current.values()) applyStreetStyle(entry, activeKey);
  }, [activeKey]);

  return (
    <div ref={shellRef} className="map-canvas-shell">
      <div ref={mapNodeRef} className="map-canvas" />
      {hover ? (
        <div className="map-hover-label" style={{ left: hover.x, top: hover.y }}>
          {hover.label}
        </div>
      ) : null}
    </div>
  );
});

function StatsStrip({ stats }) {
  return (
    <div className="stats-strip" aria-live="polite">
      <Stat icon={MapPinned} label="rues" value={formatNumber(stats.streets)} />
      <Stat icon={AlertTriangle} label="coupures" value={formatNumber(stats.outages)} />
      <Stat icon={RadioTower} label="HTA" value={formatNumber((stats.compteurIncidentHTA || 0) + (stats.compteurTravauxHTA || 0))} />
      <Stat icon={Zap} label="BT" value={formatNumber(stats.compteurBT)} />
    </div>
  );
}

function Stat({ icon: Icon, value, label }) {
  return (
    <div className="stat-tile">
      <Icon size={17} aria-hidden="true" />
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}

function CacheBadge({ cacheStatus, loading }) {
  if (loading) {
    return (
      <span className="cache-badge loading">
        <Loader2 size={14} aria-hidden="true" className="spin" />
        sync
      </span>
    );
  }
  if (!cacheStatus) return <span className="cache-badge neutral">live</span>;
  return <span className={`cache-badge ${cacheStatus.toLowerCase()}`}>{cacheStatus.toLowerCase()}</span>;
}

function SegmentedFilter({ activeFilter, onChange }) {
  const items = [
    ["all", "Toutes"],
    ["Incident HTA", "HTA"],
    ["Incident BT", "BT"],
  ];
  return (
    <div className="segmented" role="group" aria-label="Filtrer les coupures">
      {items.map(([value, label]) => (
        <button
          key={value}
          className={activeFilter === value ? "segment active" : "segment"}
          type="button"
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Insight({ icon: Icon, label, value }) {
  return (
    <div className="insight">
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function Legend() {
  return (
    <dl className="legend">
      <div>
        <dt>
          <span className="legend-dot hta" />
          HTA
        </dt>
        <dd>Incident moyenne tension, souvent étendu.</dd>
      </div>
      <div>
        <dt>
          <span className="legend-dot bt" />
          BT
        </dt>
        <dd>Incident basse tension, plus localisé.</dd>
      </div>
    </dl>
  );
}

const StreetList = forwardRef(function StreetList({ activeKey, streets, onSelectStreet }, ref) {
  if (!streets.length) {
    return (
      <div ref={ref} className="street-list empty">
        <div className="empty-state">
          <MapPinned size={22} aria-hidden="true" />
          <strong>Aucune rue à afficher</strong>
          <span>Déplacez la carte ou ajustez les filtres.</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="street-list" aria-label="Liste des rues touchées">
      {streets.map((street) => (
        <button
          key={street.key}
          type="button"
          data-street-key={street.key}
          className={street.key === activeKey ? "street-item active" : "street-item"}
          disabled={!hasMapLayer(street)}
          title={hasMapLayer(street) ? "Centrer la carte sur cette rue" : "Rue non géocodée précisément"}
          onClick={() => onSelectStreet(street)}
        >
          <div className="street-main">
            <strong>{street.label}</strong>
            <div className="street-detail">
              <span>{streetSummaryText(street)}</span>
              <span>{streetRestoreText(street)}</span>
            </div>
          </div>
          <div className="street-tags">
            {(street.outageTypes || []).map((type) => (
              <Tag key={type} type={type} />
            ))}
          </div>
        </button>
      ))}
    </div>
  );
});

function Tag({ type }) {
  const className = type.includes("HTA") ? "hta" : type.includes("BT") ? "bt" : "other";
  return <span className={`tag ${className}`}>{type.replace("Incident ", "")}</span>;
}

function createStreetEntry({ street, renderer, activeKeyRef, mapShell, onHover, onSelect }) {
  if (hasGeometry(street)) {
    return createGeometryEntry({ street, renderer, activeKeyRef, mapShell, onHover, onSelect });
  }
  if (street.geocode?.status === "ok") return createPointEntry({ street, renderer, mapShell, onHover });
  return null;
}

function createGeometryEntry({ street, renderer, activeKeyRef, mapShell, onHover, onSelect }) {
  const group = L.featureGroup();
  const bounds = [];
  const casings = [];
  const strokes = [];
  const hitAreas = [];
  let popupTarget = null;
  const lines = mergedGeometryLines(street);

  for (const coords of lines) {
    bounds.push(...coords);

    const casing = L.polyline(coords, {
      ...streetCasingStyle(street),
      renderer,
      interactive: false,
      smoothFactor: 2.2,
    }).addTo(group);
    casings.push(casing);

    const stroke = L.polyline(coords, {
      ...streetStrokeStyle(street),
      renderer,
      interactive: false,
      smoothFactor: 2.2,
    }).addTo(group);
    strokes.push(stroke);

    const hitArea = L.polyline(coords, {
      color: "#000000",
      weight: hitWeight(),
      opacity: 0,
      lineCap: "round",
      lineJoin: "round",
      renderer,
      smoothFactor: 2.2,
    }).addTo(group);
    hitArea.bindPopup(popupHtml(street));
    hitAreas.push(hitArea);
    popupTarget ||= hitArea;
  }

  if (!bounds.length) return createPointEntry({ street, renderer, mapShell, onHover });

  const entry = { layer: group, popupTarget, bounds, street, casings, strokes, hitAreas, hovered: false };
  for (const hitArea of hitAreas) {
    hitArea.on("mouseover", (event) => {
      entry.hovered = true;
      bringStreetToFront(entry);
      applyStreetStyle(entry, activeKeyRef.current);
      showHoverLabel({ street, event, mapShell, onHover });
    });
    hitArea.on("mousemove", (event) => showHoverLabel({ street, event, mapShell, onHover }));
    hitArea.on("mouseout", () => {
      entry.hovered = false;
      applyStreetStyle(entry, activeKeyRef.current);
      onHover(null);
    });
    hitArea.on("click", () => {
      onHover(null);
      onSelect?.(street.key);
      window.setTimeout(() => popupTarget?.openPopup(), 0);
    });
  }
  return entry;
}

function createPointEntry({ street, renderer, mapShell, onHover }) {
  const marker = L.circleMarker([street.geocode.lat, street.geocode.lng], {
    radius: markerRadius(street),
    color: "#ffffff",
    fillColor: markerColor(street),
    fillOpacity: 0.84,
    opacity: 0.96,
    renderer,
    weight: 3,
  });
  marker.bindPopup(popupHtml(street));
  marker.on("mouseover", (event) => showHoverLabel({ street, event, mapShell, onHover }));
  marker.on("mousemove", (event) => showHoverLabel({ street, event, mapShell, onHover }));
  marker.on("mouseout", () => onHover(null));
  marker.on("click", () => onHover(null));
  return {
    layer: marker,
    popupTarget: marker,
    bounds: [[street.geocode.lat, street.geocode.lng]],
    street,
  };
}

function focusEntry(map, entry) {
  if (!map) return;
  if (entry.layer.getBounds) {
    const layerBounds = entry.layer.getBounds();
    if (layerBounds.isValid()) {
      map.fitBounds(layerBounds, {
        padding: mapPadding(),
        maxZoom: 17.5,
        animate: true,
        duration: 0.62,
        easeLinearity: 0.22,
      });
      return;
    }
  }
  if (entry.layer.getLatLng) {
    map.setView(entry.layer.getLatLng(), 16, { animate: true, duration: 0.62, easeLinearity: 0.22 });
  }
}

function showHoverLabel({ street, event, mapShell, onHover }) {
  if (!mapShell || window.matchMedia("(pointer: coarse)").matches) return;
  const pointer = event.originalEvent || event;
  if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;

  const rect = mapShell.getBoundingClientRect();
  const x = clamp(pointer.clientX - rect.left, 14, rect.width - 14);
  const y = clamp(pointer.clientY - rect.top - 16, 24, rect.height - 14);
  onHover({ label: street.label, x, y });
}

function applyStreetStyle(entry, activeKey) {
  if (!entry.strokes?.length) return;
  const emphasized = entry.hovered || entry.street.key === activeKey;
  const casingStyle = streetCasingStyle(entry.street, emphasized);
  const strokeStyle = streetStrokeStyle(entry.street, emphasized);
  for (const casing of entry.casings) casing.setStyle(casingStyle);
  for (const stroke of entry.strokes) stroke.setStyle(strokeStyle);
}

function bringStreetToFront(entry) {
  for (const layer of [...(entry.casings || []), ...(entry.strokes || []), ...(entry.hitAreas || [])]) {
    layer.bringToFront?.();
  }
}

function viewportFromMap(map) {
  const bounds = map.getBounds();
  return {
    zoom: map.getZoom(),
    bounds: {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    },
  };
}

function viewportRequest(bounds) {
  const params = new URLSearchParams();
  params.set("south", bounds.south.toFixed(6));
  params.set("west", bounds.west.toFixed(6));
  params.set("north", bounds.north.toFixed(6));
  params.set("east", bounds.east.toFixed(6));
  return {
    params,
    key: params.toString(),
  };
}

function filterStreets(streets, activeFilter, query) {
  const normalizedQuery = query.trim().toLowerCase();
  return streets.filter((street) => {
    const filterMatches = activeFilter === "all" || street.outageTypes?.some((type) => type === activeFilter);
    if (!filterMatches) return false;
    if (!normalizedQuery) return true;
    const haystack = [
      street.label,
      street.postcode,
      street.city,
      ...(street.outageTypes || []),
      ...(street.localisations || []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

function lineCoords(line) {
  return line
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point) => [point.lat, point.lng]);
}

function hasMapLayer(street) {
  return hasGeometry(street) || street.geocode?.status === "ok";
}

function hasGeometry(street) {
  return street.geometry?.status === "ok" && street.geometry.lines?.length > 0;
}

function markerColor(street) {
  if (street.outageTypes?.includes("Incident HTA")) return "#d84a3a";
  if (street.outageTypes?.includes("Incident BT")) return "#db7100";
  return "#087b72";
}

function markerRadius(street) {
  const count = street.outageIds?.length || 1;
  return Math.min(13, 7 + count * 1.5);
}

function lineWeight(street) {
  const count = street.outageIds?.length || 1;
  return Math.min(6.6, 4.2 + Math.min(1.2, (count - 1) * 0.35));
}

function streetCasingStyle(street, emphasized = false) {
  const weight = lineWeight(street) + (emphasized ? 5.4 : 4.2);
  return {
    color: "#fffdf7",
    weight,
    opacity: emphasized ? 0.96 : 0.84,
    lineCap: "round",
    lineJoin: "round",
  };
}

function streetStrokeStyle(street, emphasized = false) {
  return {
    color: markerColor(street),
    weight: lineWeight(street) + (emphasized ? 1.8 : 0),
    opacity: emphasized ? 1 : 0.91,
    lineCap: "round",
    lineJoin: "round",
  };
}

function hitWeight() {
  return Math.max(18, lineWeight({ outageIds: [] }) + 12);
}

function mergedGeometryLines(street) {
  if (street.geometry._mergedLines) return street.geometry._mergedLines;
  const lines = (street.geometry.lines || [])
    .map(lineCoords)
    .map(cleanLine)
    .filter((line) => line.length > 1);
  street.geometry._mergedLines = mergeConnectedLines(lines);
  return street.geometry._mergedLines;
}

function mergeConnectedLines(lines) {
  const pending = lines.map((line) => [...line]);
  const merged = [];
  const tolerance = 0.000035;

  while (pending.length) {
    let current = pending.shift();
    let changed = true;

    while (changed) {
      changed = false;
      for (let index = 0; index < pending.length; index++) {
        const candidate = pending[index];
        const joined = joinLines(current, candidate, tolerance);
        if (!joined) continue;
        current = cleanLine(joined);
        pending.splice(index, 1);
        changed = true;
        break;
      }
    }

    merged.push(current);
  }

  return merged.sort((a, b) => b.length - a.length);
}

function joinLines(left, right, tolerance) {
  const leftFirst = left[0];
  const leftLast = left[left.length - 1];
  const rightFirst = right[0];
  const rightLast = right[right.length - 1];

  if (pointsClose(leftLast, rightFirst, tolerance)) return [...left, ...right.slice(1)];
  if (pointsClose(leftLast, rightLast, tolerance)) return [...left, ...[...right].reverse().slice(1)];
  if (pointsClose(leftFirst, rightLast, tolerance)) return [...right, ...left.slice(1)];
  if (pointsClose(leftFirst, rightFirst, tolerance)) return [...[...right].reverse(), ...left.slice(1)];
  return null;
}

function cleanLine(line) {
  const cleaned = [];
  for (const coord of line) {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || !pointsClose(previous, coord, 0.000001)) cleaned.push(coord);
  }
  return cleaned;
}

function pointsClose(a, b, tolerance) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

function mapPadding() {
  return window.matchMedia("(max-width: 640px)").matches ? [30, 30] : [64, 64];
}

function detailText(street) {
  return [streetSummaryText(street), streetRestoreText(street)].filter(Boolean).join(" · ");
}

function streetSummaryText(street) {
  const parts = [];
  const place = [street.city, street.postcode].filter(Boolean).join(" ");
  if (place) parts.push(place);
  if (street.outageIds?.length) parts.push(`${street.outageIds.length} coupure${street.outageIds.length > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

function streetRestoreText(street) {
  const parts = [];
  if (street.estimatedRestoreAt) parts.push(`retour ${street.estimatedRestoreAt}`);
  if (!hasGeometry(street) && street.geocode?.status !== "ok") parts.push("non géocodée");
  return parts.join(" · ");
}

function popupHtml(street) {
  const tags = (street.outageTypes || [])
    .map((type) => {
      const className = type.includes("HTA") ? "hta" : type.includes("BT") ? "bt" : "other";
      return `<span class="tag ${className}">${escapeHtml(type.replace("Incident ", ""))}</span>`;
    })
    .join("");
  return `
    <div class="popup">
      <strong>${escapeHtml(street.label)}</strong>
      <span>${escapeHtml(detailText(street))}</span>
      <div>${tags}</div>
    </div>
  `;
}

function buildStatusText(payload) {
  const stats = payload.stats || {};
  const communeCount = payload.communes?.length || payload.queries?.length || 0;
  const suffix = communeCount > 1 ? ` dans ${formatNumber(communeCount)} communes` : "";
  if (!stats.streets) return `Aucune rue touchée remontée par Enedis dans les communes visibles${suffix}.`;
  if (stats.streetGeometry) {
    return `${formatNumber(stats.streetGeometry)} rues surlignées sur ${formatNumber(stats.streets)} rues remontées par Enedis${suffix}`;
  }
  return `${formatNumber(stats.geocodedStreets)} rues placées sur ${formatNumber(stats.streets)} rues remontées par Enedis${suffix}`;
}

async function errorMessage(response) {
  try {
    const payload = await response.json();
    return payload.message || payload.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("fr-FR").format(Number(value || 0));
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  if (max < min) return value;
  return Math.min(max, Math.max(min, value));
}

function useLatest(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

createRoot(document.getElementById("root")).render(<App />);
