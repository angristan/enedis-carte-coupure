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
        label="rues"
        value={formatNumber(stats?.streets)}
      />
      <Stat
        icon={AlertTriangle}
        label="coupures"
        value={formatNumber(stats?.outages)}
      />
      <Stat
        icon={RadioTower}
        label="HTA"
        value={formatNumber(
          (stats?.compteurIncidentHTA ?? 0) + (stats?.compteurTravauxHTA ?? 0),
        )}
      />
      <Stat icon={Zap} label="BT" value={formatNumber(stats?.compteurBT)} />
    </div>
  );
}

interface StatProps {
  readonly icon: LucideIcon;
  readonly value: string;
  readonly label: string;
}

function Stat({ icon: Icon, value, label }: StatProps) {
  return (
    <div className="stat-tile">
      <Icon size={17} aria-hidden="true" />
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}
