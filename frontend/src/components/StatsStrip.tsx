import {
  AlertTriangle,
  type LucideIcon,
  MapPinned,
  RadioTower,
  Zap,
} from "lucide-react";
import type { OutageStats } from "../../../shared/api.js";
import { formatNumber } from "../domain/streets.js";

interface StatsStripProps {
  readonly stats: OutageStats | undefined;
}

export function StatsStrip({ stats }: StatsStripProps) {
  return (
    <div className="stats-strip" aria-live="polite">
      <Stat
        icon={MapPinned}
        label="Rues touchées"
        tone="teal"
        value={formatNumber(stats?.streets)}
      />
      <Stat
        icon={AlertTriangle}
        label="Coupures"
        tone="red"
        value={formatNumber(stats?.outages)}
      />
      <Stat
        icon={RadioTower}
        label="Incidents HTA"
        tone="red"
        value={formatNumber(
          (stats?.compteurIncidentHTA ?? 0) + (stats?.compteurTravauxHTA ?? 0),
        )}
      />
      <Stat
        icon={Zap}
        label="Incidents BT"
        tone="orange"
        value={formatNumber(stats?.compteurBT)}
      />
    </div>
  );
}

interface StatProps {
  readonly icon: LucideIcon;
  readonly value: string;
  readonly label: string;
  readonly tone: "teal" | "red" | "orange";
}

function Stat({ icon: Icon, value, label, tone }: StatProps) {
  return (
    <div className={`stat-tile ${tone}`}>
      <span className="stat-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span>
        <strong>{value}</strong>
        <small>{label}</small>
      </span>
    </div>
  );
}
