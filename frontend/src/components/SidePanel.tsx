import {
  type ChangeEvent,
  forwardRef,
  useEffect,
  useRef,
} from "react";
import {
  Activity,
  ChevronRight,
  Clock3,
  type LucideIcon,
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

interface SidePanelProps {
  readonly data: OutageResponse | null;
  readonly streets: ReadonlyArray<Street>;
  readonly activeKey: string;
  readonly activeFilter: StreetFilter;
  readonly query: string;
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
      onFilterChange,
      onQueryChange,
      onSelectStreet,
    },
    ref,
  ) {
    const communeCount = data?.communes?.length ?? data?.queries?.length;
    const searchInputRef = useRef<HTMLInputElement>(null);
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
      <aside className="side-pane" aria-label="Détails des coupures">
        <div className="side-header">
          <div className="side-heading">
            <p className="eyebrow">
              <Activity size={13} aria-hidden="true" />
              Veille réseau
            </p>
            <h2><strong>{formatNumber(allStreets.length)}</strong> rues touchées</h2>
            <p className="side-subtitle">dans la zone affichée</p>
          </div>
          <p className="source-badge">
            Source&nbsp;: Enedis<span> · service non officiel</span>
          </p>
        </div>

        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Recherche</span>
          <input
            ref={searchInputRef}
            value={query}
            type="search"
            placeholder="Rechercher une rue, une commune..."
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

        <div className="insight-grid" aria-label="Résumé">
          <Insight
            icon={MapPinned}
            label="Zone analysée"
            value={`${formatNumber(communeCount)} commune${communeCount === 1 ? "" : "s"}`}
          />
          <Insight
            icon={Clock3}
            label="Actualisation"
            value={formatTime(data?.updatedAt)}
          />
        </div>

        <Legend />
        <div className="list-heading">
          <span>Rues signalées</span>
          <strong>{formatNumber(streets.length)}</strong>
        </div>
        <StreetList
          ref={ref}
          activeKey={activeKey}
          streets={streets}
          onSelectStreet={onSelectStreet}
        />
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

interface InsightProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
}

function Insight({ icon: Icon, label, value }: InsightProps) {
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
    <div className="legend" aria-label="Légende des incidents">
      <div className="legend-item">
        <strong><span className="legend-dot hta" />HTA</strong>
        <span>Moyenne tension</span>
      </div>
      <div className="legend-item">
        <strong><span className="legend-dot bt" />BT</strong>
        <span>Basse tension</span>
      </div>
      <p>Les tracés colorés indiquent les rues concernées.</p>
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
