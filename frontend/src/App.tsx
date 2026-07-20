import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RotateCw, Zap } from "lucide-react";
import type { OutageResponse, Street } from "../../shared/api.js";
import { viewportIsWithinLimits } from "../../shared/viewport.js";
import { runOutageRequest } from "./api/client.js";
import { SidePanel } from "./components/SidePanel.js";
import {
  buildStatusText,
  filterStreets,
  type StreetFilter,
} from "./domain/streets.js";
import { MapView, type MapViewHandle } from "./map/MapView.js";
import {
  boundsContain,
  coverageContains,
  MIN_VIEWPORT_ZOOM,
  type ResponseCoverage,
  type Viewport,
  type ViewportRequest,
  viewportRequest,
} from "./map/viewport.js";

interface LoadOptions {
  readonly force?: boolean;
}

export function App() {
  const [data, setData] = useState<OutageResponse | null>(null);
  const [status, setStatus] = useState(
    "Chargement des coupures dans la vue...",
  );
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<StreetFilter>("all");
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [viewport, setViewport] = useState<Viewport | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const dataRef = useLatest(data);
  const viewportRef = useLatest(viewport);
  const lastLoadedRequestRef = useRef<ResponseCoverage | null>(null);
  const activeRequestRef = useRef<ViewportRequest | null>(null);
  const mapRef = useRef<MapViewHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadViewport = useCallback(
    async (nextViewport: Viewport | null, options: LoadOptions = {}) => {
      if (nextViewport === null) return;
      const request = viewportRequest(nextViewport.bounds);
      if (
        nextViewport.zoom < MIN_VIEWPORT_ZOOM ||
        !viewportIsWithinLimits(request.bounds)
      ) {
        abortRef.current?.abort();
        abortRef.current = null;
        activeRequestRef.current = null;
        lastLoadedRequestRef.current = null;
        setLoading(false);
        setData(null);
        setStatus("Zoomez davantage pour charger les rues touchées.");
        return;
      }
      const lastLoadedRequest = lastLoadedRequestRef.current;
      if (
        options.force !== true &&
        dataRef.current !== null &&
        lastLoadedRequest !== null &&
        coverageContains(lastLoadedRequest, request.bounds)
      ) {
        return;
      }
      const activeRequest = activeRequestRef.current;
      if (
        options.force !== true && activeRequest !== null &&
        boundsContain(activeRequest.bounds, request.bounds)
      ) {
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      activeRequestRef.current = request;
      setLoading(true);
      setStatus("Chargement des coupures dans la vue...");

      try {
        const result = await runOutageRequest(request, controller.signal);
        if (abortRef.current !== controller) return;
        if (result.ok === false) {
          setData(null);
          setStatus(`Erreur: ${result.error.message}`);
          return;
        }
        setData(result.data);
        setStatus(buildStatusText(result.data));
        lastLoadedRequestRef.current = {
          bounds: request.bounds,
          communes: result.data.communes ?? [],
        };
      } catch {
        if (!controller.signal.aborted && abortRef.current === controller) {
          setData(null);
          setStatus(
            "Erreur: la requête a été interrompue de façon inattendue.",
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          activeRequestRef.current = null;
          setLoading(false);
        }
      }
    },
    [dataRef],
  );

  useEffect(() => {
    void loadViewport(viewport);
  }, [loadViewport, viewport]);

  useEffect(() => {
    if (activeKey.length === 0) return;
    const selected = listRef.current?.querySelector(
      `[data-street-key="${CSS.escape(activeKey)}"]`,
    );
    selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const filteredStreets = useMemo(
    () => filterStreets(data?.streets ?? [], activeFilter, query),
    [activeFilter, data, query],
  );

  const handleInteractionStart = useCallback(() => {
    abortRef.current?.abort();
    activeRequestRef.current = null;
  }, []);

  const handleListSelect = useCallback((street: Street) => {
    setActiveKey(street.key);
    mapRef.current?.focusStreet(street.key);
  }, []);

  const handleRefresh = useCallback(() => {
    void loadViewport(viewportRef.current, { force: true });
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
          onSelectStreet={setActiveKey}
          onViewportChange={setViewport}
        />

        <header className="map-topbar">
          <div className="brand-panel">
            <span className="brand-mark" aria-hidden="true">
              <Zap size={19} strokeWidth={2.4} />
            </span>
            <div className="brand-copy">
              <div className="brand-kicker">
                <span className={loading ? "status-dot loading" : "status-dot"} />
                <span>{loading ? "Mise à jour en cours" : "Réseau en direct"}</span>
              </div>
              <h1>Carte des coupures</h1>
              <p>{status}</p>
            </div>
          </div>
          <div className="map-actions" aria-label="Actions de la carte">
            <button
              type="button"
              onClick={handleRefresh}
              title="Rafraîchir la vue"
              aria-label="Rafraîchir la vue"
            >
              <RotateCw
                size={20}
                aria-hidden="true"
                className={loading ? "spin" : ""}
              />
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

      </section>

      <SidePanel
        ref={listRef}
        data={data}
        streets={filteredStreets}
        activeKey={activeKey}
        activeFilter={activeFilter}
        query={query}
        onFilterChange={setActiveFilter}
        onQueryChange={setQuery}
        onSelectStreet={handleListSelect}
      />
    </main>
  );
}

function GitHubLogo() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.08 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.93.43.37.81 1.1.81 2.22v3.3c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z"
      />
    </svg>
  );
}

function useLatest<Value>(value: Value): MutableRefObject<Value> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
