import type { OutageResponse, Street } from "../../../shared/api.js";
import { hasGeometry } from "../map/geometry.js";

export type StreetFilter = "all" | "Incident HTA" | "Incident BT";

export function filterStreets(
  streets: ReadonlyArray<Street>,
  activeFilter: StreetFilter,
  query: string,
): ReadonlyArray<Street> {
  const normalizedQuery = query.trim().toLowerCase();
  return streets.filter((street) => {
    const filterMatches = activeFilter === "all" ||
      street.outageTypes.includes(activeFilter);
    if (!filterMatches) return false;
    if (normalizedQuery.length === 0) return true;
    const haystack = [
      street.label,
      street.postcode,
      street.city,
      ...street.outageTypes,
      ...street.localisations,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function detailText(street: Street): string {
  return [streetSummaryText(street), streetRestoreText(street)].filter(Boolean)
    .join(" · ");
}

export function streetSummaryText(street: Street): string {
  const parts: Array<string> = [];
  const place = [street.city, street.postcode].filter(Boolean).join(" ");
  if (place.length > 0) parts.push(place);
  if (street.outageIds.length > 0) {
    parts.push(
      `${street.outageIds.length} coupure${
        street.outageIds.length > 1 ? "s" : ""
      }`,
    );
  }
  return parts.join(" · ");
}

export function streetRestoreText(street: Street): string {
  const parts: Array<string> = [];
  if (street.estimatedRestoreAt.length > 0) {
    parts.push(`retour ${street.estimatedRestoreAt}`);
  }
  if (!hasGeometry(street) && street.geocode?.status !== "ok") {
    parts.push("non géocodée");
  }
  return parts.join(" · ");
}

export function buildStatusText(payload: OutageResponse): string {
  const communeCount = payload.communes?.length ?? payload.queries?.length ?? 0;
  const communeTotal = payload.communeTotal ?? communeCount;
  const suffix = communeCount > 1
    ? communeCount < communeTotal
      ? ` dans ${formatNumber(communeCount)} communes sur ${formatNumber(communeTotal)}`
      : ` dans ${formatNumber(communeCount)} communes`
    : "";
  if (payload.stats.streets === 0) {
    return `Aucune rue touchée remontée par Enedis dans les communes visibles${suffix}.`;
  }
  if (payload.stats.streetGeometry > 0) {
    return `${formatNumber(payload.stats.streetGeometry)} rues surlignées sur ${
      formatNumber(payload.stats.streets)
    } rues remontées par Enedis${suffix}`;
  }
  if (payload.stats.geocodedStreets === 0) {
    return `${
      formatNumber(payload.stats.streets)
    } rues remontées par Enedis${suffix}. Zoomez pour afficher les tracés.`;
  }
  return `${formatNumber(payload.stats.geocodedStreets)} rues placées sur ${
    formatNumber(payload.stats.streets)
  } rues remontées par Enedis${suffix}`;
}

export function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat("fr-FR").format(value ?? 0);
}

export function formatTime(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}
