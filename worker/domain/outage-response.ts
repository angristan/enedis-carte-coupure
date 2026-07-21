import { combinePolygons } from "./outage-polygons.js";
import {
  ENEDIS_ENDPOINT,
  GEOCODE_FALLBACK_ENDPOINT,
  GEOCODE_PRIMARY_ENDPOINT,
  STREET_GEOMETRY_PRIMARY_ENDPOINT,
} from "../sources.js";
import type {
  Commune,
  EnedisQuery,
  NormalizeInput,
  Outage,
  OutageResponse,
  OutageStats,
  PublicCommune,
  Street,
} from "./models.js";
import {
  earliestFrenchDate,
  latestFrenchDate,
  mergeOutageValue,
  type MutableOutage,
  type MutableStreet,
  numberValue,
  uniqueAddresses,
} from "./outage-values.js";
import { parseLocalisation } from "./street-normalization.js";
import { addUnique, stripAccents } from "./util.js";

export function normalizeOutageInputs(
  inputs: ReadonlyArray<NormalizeInput>,
  updatedAt: string,
): OutageResponse {
  const streetMap = new Map<string, MutableStreet>();
  const outageMap = new Map<string, MutableOutage>();
  const queries: Array<EnedisQuery> = [];
  const polygons: Array<unknown> = [];
  let addressRows = 0;
  let compteurIncidentHTA = 0;
  let compteurTravauxHTA = 0;
  let compteurBT = 0;
  let recap: unknown;
  let crises: unknown;

  for (const { raw, query } of inputs) {
    queries.push(query);

    if (raw.polygon !== undefined) {
      polygons.push(raw.polygon);
    }

    const data = raw.resultMegacache;

    if (data === undefined) {
      continue;
    }

    compteurIncidentHTA += numberValue(data.compteurIncidentHTA);
    compteurTravauxHTA += numberValue(data.compteurTravauxHTA);
    compteurBT += numberValue(data.compteurBT);
    recap ??= data.recap;
    crises ??= data.listeCrises;

    for (
      const [index, outage] of (data.listeCoupuresInfoReseau ?? []).entries()
    ) {
      const outageKey = outage.idCoupure ?? `${query.insee}:${index}`;
      const addresses = outage.listeAdresses ?? [];
      const outageValue: MutableOutage = {
        id: outage.idCoupure ?? "",
        status: outage.etatCoupure ?? "",
        type: outage.incidentCoupure ?? "",
        etatElectrique: numberValue(outage.etatElectrique),
        codeInsee: outage.codeInsee ?? "",
        dateCoupure: outage.dateCoupure ?? "",
        dateRealimentation: outage.dateRealimentation ?? "",
        nbFoyersCoupes: numberValue(outage.nbFoyersCoupes),
        addresses: uniqueAddresses(addresses),
      };

      mergeOutageValue(outageMap, outageKey, outageValue);

      for (const address of addresses) {
        addressRows += 1;

        const parsed = parseLocalisation(
          address.localisation ?? "",
          query.city,
        );
        const streetId = [
          parsed.normalizedKey,
          parsed.postcode,
          stripAccents(parsed.city).toUpperCase(),
        ].join("|");
        let street = streetMap.get(streetId);

        if (street === undefined) {
          street = {
            key: streetId,
            label: parsed.label,
            normalizedName: parsed.normalizedName,
            city: parsed.city,
            postcode: parsed.postcode,
            localisations: [],
            outageIds: [],
            outageTypes: [],
            firstSeenAt: "",
            estimatedRestoreAt: "",
            nbFoyersCoupes: 0,
          };
          streetMap.set(streetId, street);
        }

        addUnique(street.localisations, address.localisation ?? "");
        addUnique(street.outageIds, outage.idCoupure ?? "");
        addUnique(street.outageTypes, outage.incidentCoupure ?? "Incident");
        street.nbFoyersCoupes += numberValue(address.nbFoyersCoupes);
        street.firstSeenAt = earliestFrenchDate(
          street.firstSeenAt,
          outage.dateCoupure ?? "",
        );
        street.estimatedRestoreAt = latestFrenchDate(
          street.estimatedRestoreAt,
          outage.dateRealimentation ?? "",
        );
      }
    }
  }

  const streets: Array<Street> = [...streetMap.values()].map((street) => ({
    ...street,
    outageIds: street.outageIds.sort(),
    outageTypes: street.outageTypes.sort(),
  })).sort((first, second) => first.label.localeCompare(second.label));
  const outages: Array<Outage> = [...outageMap.values()].sort((first, second) =>
    first.id.localeCompare(second.id)
  );
  const stats = refreshStreetStats({
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
  }, streets);
  const query = queries[0] ?? emptyQuery();
  const polygon = combinePolygons(polygons);

  return {
    updatedAt,
    source: outageSource(),
    query,
    ...(queries.length > 1 ? { queries } : {}),
    ...(polygon === undefined ? {} : { polygon }),
    stats,
    outages,
    streets,
    ...(recap === undefined ? {} : { recap }),
    ...(crises === undefined ? {} : { crises }),
  };
}

export function responseCommunes(
  items: ReadonlyArray<Commune>,
): Array<PublicCommune> {
  return items.map((item) => ({
    code: item.code,
    name: item.name,
    postcodes: item.postcodes,
    ...(item.center === undefined ? {} : {
      center: {
        lat: item.center.coordinates[1],
        lng: item.center.coordinates[0],
      },
    }),
    ...(item.contour === undefined ? {} : { contour: item.contour }),
  }));
}

export function refreshStreetStats(
  stats: OutageStats,
  streets: ReadonlyArray<Street>,
): OutageStats {
  let geocodedStreets = 0;
  let geocodeMisses = 0;
  let streetGeometry = 0;
  let streetGeometryMisses = 0;

  for (const street of streets) {
    if (street.geocode?.status === "ok") {
      geocodedStreets += 1;
    } else if (street.geocode !== undefined) {
      geocodeMisses += 1;
    }

    if (street.geometry?.status === "ok" && street.geometry.lines.length > 0) {
      streetGeometry += 1;
    } else if (street.geometry !== undefined) {
      streetGeometryMisses += 1;
    }
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

export function outageSource(): OutageResponse["source"] {
  return {
    enedisEndpoint: ENEDIS_ENDPOINT,
    geocoderEndpoint: GEOCODE_PRIMARY_ENDPOINT,
    geocoderFallbackEndpoint: GEOCODE_FALLBACK_ENDPOINT,
    streetGeometryEndpoint: STREET_GEOMETRY_PRIMARY_ENDPOINT,
  };
}

function emptyQuery(): EnedisQuery {
  return {
    insee: "",
    type: "",
    adresse: "",
    CPVille: "",
    name: "",
    district: "",
    city: "",
  };
}
