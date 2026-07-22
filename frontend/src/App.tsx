import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight, RotateCw, Zap } from "lucide-react";
import type { OutageResponse, Street } from "../../shared/api.js";
import { viewportIsWithinLimits } from "../../shared/viewport.js";
import {
  runOutageRequest,
  runSessionStatusRequest,
  runTurnstileVerification,
} from "./api/client.js";
import { SidePanel } from "./components/SidePanel.js";
import { StatsStrip } from "./components/StatsStrip.js";
import { TurnstileGate } from "./components/TurnstileGate.js";
import {
  buildStatusText,
  filterStreets,
  type StreetFilter,
} from "./domain/streets.js";
import { mergeOutagePages } from "./domain/outagePages.js";
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
  const [sessionChecked, setSessionChecked] = useState(false);
  const [sessionVerified, setSessionVerified] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("");
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [desktopExplorerOpen, setDesktopExplorerOpen] = useState(() => {
    try {
      return window.localStorage.getItem("enedis:explorer-open") !== "false";
    } catch {
      return true;
    }
  });

  const abortRef = useRef<AbortController | null>(null);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const dataRef = useLatest(data);
  const viewportRef = useLatest(viewport);
  const lastLoadedRequestRef = useRef<ResponseCoverage | null>(null);
  const activeRequestRef = useRef<ViewportRequest | null>(null);
  const mapRef = useRef<MapViewHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadViewport = useCallback(
    async (nextViewport: Viewport | null, options: LoadOptions = {}) => {
      if (nextViewport === null || !sessionVerified) return;
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

      let latestData: OutageResponse | null = null;
      try {
        const pages = new Map<string, OutageResponse>();
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        while (abortRef.current === controller) {
          const pageId = cursor ?? "first";
          if (seenCursors.has(pageId)) {
            setStatus("Chargement partiel: pagination invalide.");
            return;
          }
          seenCursors.add(pageId);

          const result = await runOutageRequest(
            viewportRequest(nextViewport.bounds, cursor),
            controller.signal,
          );
          if (abortRef.current !== controller) return;
          if (result.ok === false) {
            if (
              result.error._tag === "ApiStatusError" &&
              result.error.status === 401
            ) setSessionVerified(false);
            if (latestData === null) setData(null);
            setStatus(
              latestData === null
                ? `Erreur: ${result.error.message}`
                : `Chargement partiel: ${result.error.message}`,
            );
            return;
          }

          pages.set(pageId, result.data);
          const merged = mergeOutagePages([...pages.values()]);
          if (merged === null) return;
          latestData = merged;
          setData(merged);
          setStatus(buildStatusText(merged));

          cursor = result.data.nextCursor;
          if (cursor === undefined) {
            lastLoadedRequestRef.current = {
              bounds: request.bounds,
              communes: merged.communes ?? [],
            };
            return;
          }
        }
      } catch {
        if (!controller.signal.aborted && abortRef.current === controller) {
          if (latestData === null) setData(null);
          setStatus(
            latestData === null
              ? "Erreur: la requête a été interrompue de façon inattendue."
              : "Chargement partiel: la requête a été interrompue de façon inattendue.",
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
    [dataRef, sessionVerified],
  );

  useEffect(() => {
    const controller = new AbortController();
    sessionAbortRef.current = controller;
    void runSessionStatusRequest(controller.signal).then((result) => {
      if (sessionAbortRef.current !== controller) return;
      setSessionChecked(true);
      if (result.ok) {
        setSessionVerified(result.data.verified);
        setTurnstileSiteKey(result.data.turnstileSiteKey);
      } else {
        setStatus(`Erreur: ${result.error.message}`);
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void loadViewport(viewport);
  }, [loadViewport, viewport]);

  useEffect(() => {
    if (!mobilePanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMobilePanelOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobilePanelOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "enedis:explorer-open",
        String(desktopExplorerOpen),
      );
    } catch {
      // The explorer remains usable when browser storage is unavailable.
    }
  }, [desktopExplorerOpen]);

  useEffect(() => {
    if (activeKey.length === 0) return;
    const selected = listRef.current?.querySelector(
      `[data-street-key="${CSS.escape(activeKey)}"]`,
    );
    selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeKey]);

  useEffect(() => () => {
    abortRef.current?.abort();
    sessionAbortRef.current?.abort();
  }, []);

  const filteredStreets = useMemo(
    () => filterStreets(data?.streets ?? [], activeFilter, query),
    [activeFilter, data, query],
  );

  const handleInteractionStart = useCallback(() => {
    abortRef.current?.abort();
    activeRequestRef.current = null;
    setMobilePanelOpen(false);
  }, []);

  const handleListSelect = useCallback((street: Street) => {
    setActiveKey(street.key);
    setMobilePanelOpen(false);
    mapRef.current?.focusStreet(street.key);
  }, []);

  const handleRefresh = useCallback(() => {
    void loadViewport(viewportRef.current, { force: true });
  }, [loadViewport, viewportRef]);

  const handleTurnstileToken = useCallback(async (token: string) => {
    const controller = new AbortController();
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = controller;
    const result = await runTurnstileVerification(token, controller.signal);
    if (sessionAbortRef.current !== controller || result.ok === false) {
      if (result.ok === false) setStatus(`Erreur: ${result.error.message}`);
      return false;
    }
    setSessionVerified(true);
    setStatus("Chargement des coupures dans la vue...");
    return true;
  }, []);

  return (
    <main className="app-shell">
      <header className="map-topbar">
        <div className="brand-panel">
          <span className="brand-mark" aria-hidden="true">
            <Zap size={21} strokeWidth={2.4} />
          </span>
          <div className="brand-copy">
            <h1>Enedis <em>Signal</em></h1>
            <div className="brand-kicker">
              <span className={loading ? "status-dot loading" : "status-dot"} />
              <span>{loading ? "Mise à jour en cours" : "Coupures en direct"}</span>
            </div>
            <p>{status}</p>
          </div>
        </div>

        <StatsStrip stats={data?.stats} />

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
            href="https://github.com/angristan/enedis"
            target="_blank"
            rel="noreferrer"
            title="Voir le dépôt GitHub"
            aria-label="Voir le dépôt GitHub"
          >
            <GitHubLogo />
          </a>
        </div>
      </header>

      <section
        className="workspace"
        data-explorer-open={desktopExplorerOpen}
      >
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
          <div className="map-status-card" aria-live="polite">
            <strong>Carte des coupures</strong>
            <span>{status}</span>
          </div>
          <div className="outage-map-legend" aria-label="Légende des incidents">
            <span><i className="legend-dot hta" />HTA · moyenne tension</span>
            <span><i className="legend-dot bt" />BT · basse tension</span>
          </div>
          <button
            type="button"
            className="explorer-edge-toggle"
            aria-controls="outage-details-content"
            aria-expanded={desktopExplorerOpen}
            aria-label={desktopExplorerOpen
              ? "Masquer l’explorateur des coupures"
              : "Afficher l’explorateur des coupures"}
            title={desktopExplorerOpen
              ? "Masquer l’explorateur"
              : "Afficher l’explorateur"}
            onClick={() => setDesktopExplorerOpen((open) => !open)}
          >
            {desktopExplorerOpen
              ? <ChevronLeft size={21} aria-hidden="true" />
              : <ChevronRight size={21} aria-hidden="true" />}
          </button>
        </section>

        {mobilePanelOpen
          ? (
            <button
              className="mobile-sheet-backdrop"
              type="button"
              aria-label="Fermer la liste des rues"
              onClick={() => setMobilePanelOpen(false)}
            />
          )
          : null}
        <SidePanel
          ref={listRef}
          data={data}
          streets={filteredStreets}
          activeKey={activeKey}
          activeFilter={activeFilter}
          query={query}
          mobileOpen={mobilePanelOpen}
          onMobileToggle={() => setMobilePanelOpen((open) => !open)}
          onFilterChange={setActiveFilter}
          onQueryChange={setQuery}
          onSelectStreet={handleListSelect}
        />
      </section>

      {sessionChecked && !sessionVerified && turnstileSiteKey.length > 0
        ? (
          <TurnstileGate
            siteKey={turnstileSiteKey}
            onToken={handleTurnstileToken}
          />
        )
        : null}
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
