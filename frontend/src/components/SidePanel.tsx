import {
  type ChangeEvent,
  forwardRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  List,
  MapPinned,
  Search,
} from "lucide-react";
import type { OutageResponse, Street } from "../../../shared/api.js";
import {
  detailText,
  formatNumber,
  formatTime,
  type StreetFilter,
  streetRestoreText,
  streetSummaryText,
} from "../domain/streets.js";
import { hasMapLayer } from "../map/geometry.js";
import {
  MOBILE_SHEET_DRAG_THRESHOLD,
  mobileSheetPosition,
  shouldOpenMobileSheet,
} from "./mobileSheet.js";

interface MobileSheetDrag {
  readonly pointerId: number;
  readonly startY: number;
  readonly startTime: number;
  readonly travel: number;
  dragged: boolean;
}

interface SidePanelProps {
  readonly data: OutageResponse | null;
  readonly streets: ReadonlyArray<Street>;
  readonly activeKey: string;
  readonly activeFilter: StreetFilter;
  readonly query: string;
  readonly mobileOpen: boolean;
  readonly onMobileToggle: () => void;
  readonly onFilterChange: (filter: StreetFilter) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onSelectStreet: (street: Street) => void;
}

export const SidePanel = forwardRef<HTMLDivElement, SidePanelProps>(
  function SidePanel(
    {
      data,
      streets,
      activeKey,
      activeFilter,
      query,
      mobileOpen,
      onMobileToggle,
      onFilterChange,
      onQueryChange,
      onSelectStreet,
    },
    ref,
  ) {
    const communeCount = data?.communes?.length ?? data?.queries?.length;
    const communeTotal = data?.communeTotal ?? communeCount;
    const searchInputRef = useRef<HTMLInputElement>(null);
    const sidePaneRef = useRef<HTMLElement>(null);
    const mobileDragRef = useRef<MobileSheetDrag | null>(null);
    const suppressMobileClickUntilRef = useRef(0);
    const [mobileDragPosition, setMobileDragPosition] = useState<number | null>(
      null,
    );
    const [mobileDragging, setMobileDragging] = useState(false);
    const allStreets = data?.streets ?? [];
    const filterCounts: Record<StreetFilter, number> = {
      all: allStreets.length,
      "Incident HTA": allStreets.filter((street) =>
        street.outageTypes.includes("Incident HTA")
      ).length,
      "Incident BT": allStreets.filter((street) =>
        street.outageTypes.includes("Incident BT")
      ).length,
    };
    const handleQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
      onQueryChange(event.target.value);
    };
    const handleMobilePointerDown = (
      event: ReactPointerEvent<HTMLButtonElement>,
    ): void => {
      if (!event.isPrimary || event.button !== 0) return;
      const panel = sidePaneRef.current;
      if (panel === null) return;
      const travel = Math.max(
        0,
        panel.offsetHeight - event.currentTarget.offsetHeight,
      );
      if (travel === 0) return;

      suppressMobileClickUntilRef.current = 0;
      mobileDragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startTime: event.timeStamp,
        travel,
        dragged: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };
    const handleMobilePointerMove = (
      event: ReactPointerEvent<HTMLButtonElement>,
    ): void => {
      const drag = mobileDragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const deltaY = event.clientY - drag.startY;
      if (!drag.dragged && Math.abs(deltaY) < MOBILE_SHEET_DRAG_THRESHOLD) {
        return;
      }

      drag.dragged = true;
      event.preventDefault();
      setMobileDragging(true);
      setMobileDragPosition(
        mobileSheetPosition(mobileOpen, drag.travel, deltaY),
      );
    };
    const finishMobileDrag = (
      event: ReactPointerEvent<HTMLButtonElement>,
      canceled: boolean,
    ): void => {
      const drag = mobileDragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      mobileDragRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (drag.dragged && !canceled) {
        const deltaY = event.clientY - drag.startY;
        const position = mobileSheetPosition(mobileOpen, drag.travel, deltaY);
        const elapsed = Math.max(1, event.timeStamp - drag.startTime);
        const shouldOpen = shouldOpenMobileSheet({
          position,
          travel: drag.travel,
          velocityY: deltaY / elapsed,
          distanceY: deltaY,
        });
        suppressMobileClickUntilRef.current = event.timeStamp + 100;
        if (shouldOpen !== mobileOpen) onMobileToggle();
      }

      setMobileDragging(false);
      setMobileDragPosition(null);
    };
    const handleMobileClick = (
      event: ReactMouseEvent<HTMLButtonElement>,
    ): void => {
      if (event.timeStamp <= suppressMobileClickUntilRef.current) {
        suppressMobileClickUntilRef.current = 0;
        event.preventDefault();
        return;
      }
      onMobileToggle();
    };

    useEffect(() => {
      const focusSearch = (event: KeyboardEvent): void => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          searchInputRef.current?.focus();
        }
      };
      window.addEventListener("keydown", focusSearch);
      return () => window.removeEventListener("keydown", focusSearch);
    }, []);

    return (
      <aside
        ref={sidePaneRef}
        className={[
          "side-pane",
          mobileOpen ? "mobile-open" : "",
          mobileDragging ? "mobile-dragging" : "",
        ].filter(Boolean).join(" ")}
        style={mobileDragPosition === null
          ? undefined
          : { transform: `translateY(${mobileDragPosition}px)` }}
        aria-label="Détails des coupures"
      >
        <button
          className="mobile-sheet-toggle"
          type="button"
          aria-controls="outage-details-content"
          aria-expanded={mobileOpen}
          onClick={handleMobileClick}
          onPointerDown={handleMobilePointerDown}
          onPointerMove={handleMobilePointerMove}
          onPointerUp={(event) => finishMobileDrag(event, false)}
          onPointerCancel={(event) => finishMobileDrag(event, true)}
        >
          <span className="mobile-sheet-handle" aria-hidden="true" />
          <span className="mobile-sheet-summary">
            <List size={18} aria-hidden="true" />
            <strong>{formatNumber(allStreets.length)}</strong>
            <span>rues touchées</span>
          </span>
          <span className="mobile-sheet-action">
            {mobileOpen ? "Réduire" : "Voir la liste"}
            <ChevronDown size={18} aria-hidden="true" />
          </span>
        </button>

        <div id="outage-details-content" className="side-content">
          <div className="side-header">
            <div className="side-heading">
              <p className="eyebrow">Explorer</p>
              <h2>Rues touchées</h2>
            </div>
            <span className="result-count">
              {formatNumber(streets.length)} / {formatNumber(allStreets.length)}
            </span>
          </div>

          <label className="search-box">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Recherche</span>
            <input
              ref={searchInputRef}
              value={query}
              type="search"
              placeholder="Rechercher une rue ou une commune"
              autoComplete="off"
              onChange={handleQueryChange}
            />
            <span className="search-hint" aria-hidden="true">⌘ K</span>
          </label>

          <SegmentedFilter
            activeFilter={activeFilter}
            counts={filterCounts}
            onChange={onFilterChange}
          />

          <div className="explorer-meta" aria-label="Périmètre des résultats">
            <span>
              {communeCount !== undefined && communeTotal !== undefined &&
                  communeCount < communeTotal
                ? `${formatNumber(communeCount)} / ${formatNumber(communeTotal)} communes`
                : `${formatNumber(communeCount)} commune${communeCount === 1 ? "" : "s"}`}
            </span>
            <span>{data === null
              ? "Actualisation en attente"
              : `Actualisé à ${formatTime(data.updatedAt)}`}</span>
          </div>
          <StreetList
            ref={ref}
            activeKey={activeKey}
            streets={streets}
            onSelectStreet={onSelectStreet}
          />
          <footer className="source-badge">
            Service non officiel · Données Enedis
          </footer>
        </div>
      </aside>
    );
  },
);

interface SegmentedFilterProps {
  readonly activeFilter: StreetFilter;
  readonly counts: Readonly<Record<StreetFilter, number>>;
  readonly onChange: (filter: StreetFilter) => void;
}

const filterItems: ReadonlyArray<readonly [StreetFilter, string]> = [
  ["all", "Toutes"],
  ["Incident HTA", "HTA"],
  ["Incident BT", "BT"],
];

function SegmentedFilter(
  { activeFilter, counts, onChange }: SegmentedFilterProps,
) {
  return (
    <div className="segmented" role="group" aria-label="Filtrer les coupures">
      {filterItems.map(([value, label]) => (
        <button
          key={value}
          className={activeFilter === value ? "segment active" : "segment"}
          type="button"
          onClick={() => onChange(value)}
        >
          <span>{label}</span>
          <small>{formatNumber(counts[value])}</small>
        </button>
      ))}
    </div>
  );
}

interface StreetListProps {
  readonly activeKey: string;
  readonly streets: ReadonlyArray<Street>;
  readonly onSelectStreet: (street: Street) => void;
}

const StreetList = forwardRef<HTMLDivElement, StreetListProps>(
  function StreetList(
    { activeKey, streets, onSelectStreet },
    ref,
  ) {
    if (streets.length === 0) {
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
      <div
        ref={ref}
        className="street-list"
        aria-label="Liste des rues touchées"
      >
        {streets.map((street) => {
          const mapped = hasMapLayer(street);
          return (
            <button
              key={street.key}
              type="button"
              data-street-key={street.key}
              className={street.key === activeKey
                ? "street-item active"
                : "street-item"}
              disabled={!mapped}
              title={mapped
                ? "Centrer la carte sur cette rue"
                : "Rue non géocodée précisément"}
              onClick={() => onSelectStreet(street)}
            >
              <span
                className={`street-signal ${streetTone(street)}`}
                aria-hidden="true"
              />
              <div className="street-main">
                <strong>{street.label}</strong>
                <div className="street-detail">
                  <span>{streetSummaryText(street)}</span>
                  <span>{streetRestoreText(street)}</span>
                </div>
              </div>
              <div className="street-meta">
                <div className="street-tags">
                  {street.outageTypes.map((type) => (
                    <Tag key={type} type={type} />
                  ))}
                </div>
                {mapped ? <ChevronRight size={17} aria-hidden="true" /> : null}
              </div>
            </button>
          );
        })}
      </div>
    );
  },
);

function streetTone(street: Street): string {
  if (street.outageTypes.some((type) => type.includes("HTA"))) return "hta";
  if (street.outageTypes.some((type) => type.includes("BT"))) return "bt";
  return "other";
}

interface TagProps {
  readonly type: string;
}

export function Tag({ type }: TagProps) {
  const className = type.includes("HTA")
    ? "hta"
    : type.includes("BT")
    ? "bt"
    : "other";
  return (
    <span className={`tag ${className}`}>{type.replace("Incident ", "")}</span>
  );
}

export function StreetPopup({ street }: { readonly street: Street }) {
  return (
    <div className="popup">
      <strong>{street.label}</strong>
      <span>{detailText(street)}</span>
      <div>
        {street.outageTypes.map((type) => <Tag key={type} type={type} />)}
      </div>
    </div>
  );
}
