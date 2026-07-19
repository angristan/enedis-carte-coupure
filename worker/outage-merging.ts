import type { EnedisQuery, Outage, OutageResponse, Street } from "./models.js";
import { combinePolygons } from "./outage-polygons.js";
import {
  normalizeOutageInputs,
  outageSource,
  refreshStreetStats,
} from "./outage-response.js";
import {
  mergeOutageValue,
  mergeStreetValue,
  type MutableOutage,
  type MutableStreet,
} from "./outage-values.js";

export function mergeOutageResponses(
  responses: ReadonlyArray<OutageResponse>,
): OutageResponse {
  if (responses.length === 0) {
    return normalizeOutageInputs([], new Date(0).toISOString());
  }

  const streetMap = new Map<string, MutableStreet>();
  const outageMap = new Map<string, MutableOutage>();
  const queries: Array<EnedisQuery> = [];
  const warnings: Array<string> = [];
  const polygons: Array<unknown> = [];
  let recap: unknown;
  let crises: unknown;
  let addressRows = 0;
  let compteurIncidentHTA = 0;
  let compteurTravauxHTA = 0;
  let compteurBT = 0;
  let updatedAt = "";

  for (const response of responses) {
    if (response.updatedAt > updatedAt) {
      updatedAt = response.updatedAt;
    }

    for (const query of response.queries ?? [response.query]) {
      const queryAlreadyPresent = queries.some((item) =>
        item.insee === query.insee && item.city === query.city
      );

      if (!queryAlreadyPresent) {
        queries.push(query);
      }
    }

    addressRows += response.stats.addressRows;
    compteurIncidentHTA += response.stats.compteurIncidentHTA;
    compteurTravauxHTA += response.stats.compteurTravauxHTA;
    compteurBT += response.stats.compteurBT;

    if (response.polygon !== undefined) {
      polygons.push(response.polygon);
    }

    recap ??= response.recap;
    crises ??= response.crises;
    warnings.push(...(response.warnings ?? []));

    for (const street of response.streets) {
      mergeStreetValue(streetMap, street);
    }
    for (const outage of response.outages) {
      mergeResponseOutage(outageMap, outage);
    }
  }

  const streets: Array<Street> = [...streetMap.values()].sort(
    (first, second) => first.label.localeCompare(second.label),
  );
  const outages: Array<Outage> = [...outageMap.values()].sort(
    (first, second) => first.id.localeCompare(second.id),
  );
  const query = queries[0] ?? responses[0].query;
  const polygon = combinePolygons(polygons);

  return {
    updatedAt,
    source: outageSource(),
    query,
    ...(queries.length > 1 ? { queries } : {}),
    ...(polygon === undefined ? {} : { polygon }),
    stats: refreshStreetStats({
      outages: outages.length,
      addressRows,
      streets: streets.length,
      geocodedStreets: 0,
      geocodeMisses: 0,
      streetGeometry: 0,
      streetGeometryMisses: 0,
      compteurIncidentHTA,
      compteurTravauxHTA,
      compteurBT,
    }, streets),
    outages,
    streets,
    ...(recap === undefined ? {} : { recap }),
    ...(crises === undefined ? {} : { crises }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

function mergeResponseOutage(
  map: Map<string, MutableOutage>,
  outage: Outage,
): void {
  const key = `${outage.codeInsee}:${outage.id}:${outage.dateCoupure}`;

  mergeOutageValue(map, key, {
    ...outage,
    addresses: [...outage.addresses],
  });
}
