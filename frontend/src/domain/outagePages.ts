import type {
  EnedisQuery,
  Outage,
  OutageResponse,
  OutageStats,
  PublicCommune,
  Street,
} from "../../../shared/api.js";

export function mergeOutagePages(
  pages: ReadonlyArray<OutageResponse>,
): OutageResponse | null {
  const first = pages[0];
  if (first === undefined) return null;

  const streets = new Map<string, Street>();
  const outages = new Map<string, Outage>();
  const communes = new Map<string, PublicCommune>();
  const queries = new Map<string, EnedisQuery>();
  const warnings = new Set<string>();
  const polygons: Array<unknown> = [];
  let updatedAt = first.updatedAt;
  let addressRows = 0;
  let compteurIncidentHTA = 0;
  let compteurTravauxHTA = 0;
  let compteurBT = 0;
  let recap = first.recap;
  let crises = first.crises;

  for (const page of pages) {
    if (page.updatedAt > updatedAt) updatedAt = page.updatedAt;
    addressRows += page.stats.addressRows;
    compteurIncidentHTA += page.stats.compteurIncidentHTA;
    compteurTravauxHTA += page.stats.compteurTravauxHTA;
    compteurBT += page.stats.compteurBT;
    recap ??= page.recap;
    crises ??= page.crises;
    if (page.polygon !== undefined) polygons.push(page.polygon);
    for (const warning of page.warnings ?? []) warnings.add(warning);
    for (const commune of page.communes ?? []) communes.set(commune.code, commune);
    for (const query of page.queries ?? [page.query]) {
      queries.set(`${query.insee}:${query.city}`, query);
    }
    for (const street of page.streets) mergeStreet(streets, street);
    for (const outage of page.outages) mergeOutage(outages, outage);
  }

  const mergedStreets = [...streets.values()].sort((left, right) =>
    left.label.localeCompare(right.label)
  );
  const mergedOutages = [...outages.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const mergedQueries = [...queries.values()];
  const last = pages.at(-1) ?? first;
  const polygon = combinePolygons(polygons);

  return {
    updatedAt,
    source: first.source,
    query: mergedQueries[0] ?? first.query,
    ...(mergedQueries.length > 1 ? { queries: mergedQueries } : {}),
    ...(polygon === undefined ? {} : { polygon }),
    stats: refreshStats({
      outages: mergedOutages.length,
      addressRows,
      streets: mergedStreets.length,
      geocodedStreets: 0,
      geocodeMisses: 0,
      streetGeometry: 0,
      streetGeometryMisses: 0,
      compteurIncidentHTA,
      compteurTravauxHTA,
      compteurBT,
    }, mergedStreets),
    outages: mergedOutages,
    streets: mergedStreets,
    ...(recap === undefined ? {} : { recap }),
    ...(crises === undefined ? {} : { crises }),
    ...(first.viewport === undefined ? {} : { viewport: first.viewport }),
    communes: [...communes.values()],
    communeTotal: first.communeTotal ?? communes.size,
    ...(last.nextCursor === undefined ? {} : { nextCursor: last.nextCursor }),
    warnings: [...warnings],
  };
}

function mergeStreet(map: Map<string, Street>, street: Street): void {
  const current = map.get(street.key);
  if (current === undefined) {
    map.set(street.key, {
      ...street,
      localisations: [...street.localisations],
      outageIds: [...street.outageIds],
      outageTypes: [...street.outageTypes],
    });
    return;
  }

  map.set(street.key, {
    ...current,
    localisations: unique([...current.localisations, ...street.localisations]),
    outageIds: unique([...current.outageIds, ...street.outageIds]),
    outageTypes: unique([...current.outageTypes, ...street.outageTypes]),
    firstSeenAt: earliestDate(current.firstSeenAt, street.firstSeenAt),
    estimatedRestoreAt: latestDate(
      current.estimatedRestoreAt,
      street.estimatedRestoreAt,
    ),
    nbFoyersCoupes: current.nbFoyersCoupes + street.nbFoyersCoupes,
    geocode: current.geocode ?? street.geocode,
    geometry: current.geometry ?? street.geometry,
  });
}

function mergeOutage(map: Map<string, Outage>, outage: Outage): void {
  const key = `${outage.codeInsee}:${outage.id}:${outage.dateCoupure}`;
  const current = map.get(key);
  if (current === undefined) {
    map.set(key, { ...outage, addresses: [...outage.addresses] });
    return;
  }

  const addresses = [...current.addresses];
  for (const address of outage.addresses) {
    if (!addresses.some((item) =>
      item.localisation === address.localisation &&
      item.nbFoyersCoupes === address.nbFoyersCoupes
    )) addresses.push(address);
  }
  map.set(key, {
    ...current,
    dateCoupure: earliestDate(current.dateCoupure, outage.dateCoupure),
    dateRealimentation: latestDate(
      current.dateRealimentation,
      outage.dateRealimentation,
    ),
    nbFoyersCoupes: current.nbFoyersCoupes + outage.nbFoyersCoupes,
    addresses,
  });
}

function refreshStats(stats: OutageStats, streets: ReadonlyArray<Street>) {
  let geocodedStreets = 0;
  let geocodeMisses = 0;
  let streetGeometry = 0;
  let streetGeometryMisses = 0;
  for (const street of streets) {
    if (street.geocode?.status === "ok") geocodedStreets += 1;
    else if (street.geocode !== undefined) geocodeMisses += 1;
    if (street.geometry?.status === "ok" && street.geometry.lines.length > 0) {
      streetGeometry += 1;
    } else if (street.geometry !== undefined) streetGeometryMisses += 1;
  }
  return {
    ...stats,
    streets: streets.length,
    geocodedStreets,
    geocodeMisses,
    streetGeometry,
    streetGeometryMisses,
  };
}

function unique(values: ReadonlyArray<string>): Array<string> {
  return [...new Set(values)].sort();
}

function earliestDate(left: string, right: string): string {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return parseFrenchDate(left) <= parseFrenchDate(right) ? left : right;
}

function latestDate(left: string, right: string): string {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return parseFrenchDate(left) >= parseFrenchDate(right) ? left : right;
}

function parseFrenchDate(value: string): number {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/u);
  if (match === null) return 0;
  return new Date(
    Number(match[3]),
    Number(match[2]) - 1,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
}

function combinePolygons(polygons: ReadonlyArray<unknown>): unknown | undefined {
  const values = polygons.filter(isGeoJsonValue);
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0];

  const features: Array<object> = [];
  for (const value of values) {
    if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
      features.push(...value.features.filter(isObject));
    } else if (value.type === "Feature") {
      features.push(value);
    } else {
      features.push({ type: "Feature", geometry: value, properties: {} });
    }
  }
  return { type: "FeatureCollection", features };
}

function isGeoJsonValue(value: unknown): value is Record<string, unknown> {
  return isObject(value) && typeof value.type === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
