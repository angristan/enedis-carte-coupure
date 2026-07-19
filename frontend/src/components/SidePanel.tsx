import { type ChangeEvent, forwardRef } from "react";
import { Clock3, type LucideIcon, MapPinned, Search } from "lucide-react";
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
    const handleQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
      onQueryChange(event.target.value);
    };

    return (
      <aside className="side-pane" aria-label="Détails des coupures">
        <div className="side-header">
          <div>
            <p className="eyebrow">Vue active</p>
            <h2>{formatNumber(streets.length)} rues visibles</h2>
          </div>
        </div>

        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Recherche</span>
          <input
            value={query}
            type="search"
            placeholder="Rue, commune, incident"
            autoComplete="off"
            onChange={handleQueryChange}
          />
        </label>

        <SegmentedFilter
          activeFilter={activeFilter}
          onChange={onFilterChange}
        />

        <div className="insight-grid" aria-label="Résumé">
          <Insight
            icon={MapPinned}
            label="Communes"
            value={formatNumber(communeCount)}
          />
          <Insight
            icon={Clock3}
            label="Mis à jour"
            value={formatTime(data?.updatedAt)}
          />
        </div>

        <Legend />
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
  readonly onChange: (filter: StreetFilter) => void;
}

const filterItems: ReadonlyArray<readonly [StreetFilter, string]> = [
  ["all", "Toutes"],
  ["Incident HTA", "HTA"],
  ["Incident BT", "BT"],
];

function SegmentedFilter({ activeFilter, onChange }: SegmentedFilterProps) {
  return (
    <div className="segmented" role="group" aria-label="Filtrer les coupures">
      {filterItems.map(([value, label]) => (
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
    <dl className="legend">
      <div>
        <dt>
          <span className="legend-dot hta" />HTA
        </dt>
        <dd>Incident moyenne tension, souvent étendu.</dd>
      </div>
      <div>
        <dt>
          <span className="legend-dot bt" />BT
        </dt>
        <dd>Incident basse tension, plus localisé.</dd>
      </div>
    </dl>
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
              <div className="street-main">
                <strong>{street.label}</strong>
                <div className="street-detail">
                  <span>{streetSummaryText(street)}</span>
                  <span>{streetRestoreText(street)}</span>
                </div>
              </div>
              <div className="street-tags">
                {street.outageTypes.map((type) => (
                  <Tag key={type} type={type} />
                ))}
              </div>
            </button>
          );
        })}
      </div>
    );
  },
);

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
