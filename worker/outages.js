import { ENEDIS_ENDPOINT } from "./enedis.js";
import { GEOCODE_FALLBACK_ENDPOINT, GEOCODE_PRIMARY_ENDPOINT, publicGeocode } from "./geocode.js";
import { STREET_GEOMETRY_PRIMARY_ENDPOINT, streetKey } from "./streetgeom.js";
import { enterSpan } from "./trace.js";
import { addUnique, mapLimit, stripAccents } from "./util.js";

const MAX_GEOCODE_CONCURRENCY = 4;
const GEOCODE_MISS_DELAY_MS = 120;

export class Normalizer {
  constructor(geocoder, geometries, traceCtx) {
    this.geocoder = geocoder;
    this.geometries = geometries;
    this.traceCtx = traceCtx;
  }

  async normalize(raw, query, shouldGeocode) {
    return this.normalizeSet([{ raw, query }], shouldGeocode, null);
  }

  async normalizeSet(inputs, shouldGeocode, geometryBounds) {
    const options = normalizeOptions(shouldGeocode, geometryBounds);
    return enterSpan(this.traceCtx, "outages.normalize", { "outages.inputs": inputs.length, "outages.geocode": options.geocode }, async (span) => {
      const streetMap = new Map();
      const outageMap = new Map();
      const polygons = [];
      const queries = [];
      let addressRows = 0;
      let compteurIncidentHTA = 0;
      let compteurTravauxHTA = 0;
      let compteurBT = 0;
      let recap = null;
      let crises = null;

      for (const input of inputs) {
        const raw = input.raw || {};
        const query = input.query || {};
        queries.push(query);
        if (raw.polygon) polygons.push(raw.polygon);

        const resultMegacache = raw.resultMegacache || {};
        compteurIncidentHTA += number(resultMegacache.compteurIncidentHTA);
        compteurTravauxHTA += number(resultMegacache.compteurTravauxHTA);
        compteurBT += number(resultMegacache.compteurBT);
        if (!recap && resultMegacache.recap) recap = resultMegacache.recap;
        if (!crises && resultMegacache.listeCrises) crises = resultMegacache.listeCrises;

        for (const [outageIndex, outage] of (resultMegacache.listeCoupuresInfoReseau || []).entries()) {
          const outageKey = outage.idCoupure || `${query.insee}:${outageIndex}`;
          const addresses = outage.listeAdresses || [];
          const existing = outageMap.get(outageKey);
          if (existing) {
            existing.dateCoupure = earliestFrenchDate(existing.dateCoupure, outage.dateCoupure);
            existing.dateRealimentation = latestFrenchDate(existing.dateRealimentation, outage.dateRealimentation);
            existing.nbFoyersCoupes += number(outage.nbFoyersCoupes);
            for (const address of addresses) addUniqueAddress(existing.addresses, address);
          } else {
            outageMap.set(outageKey, {
              id: outage.idCoupure || "",
              status: outage.etatCoupure || "",
              type: outage.incidentCoupure || "",
              etatElectrique: number(outage.etatElectrique),
              codeInsee: outage.codeInsee || "",
              dateCoupure: outage.dateCoupure || "",
              dateRealimentation: outage.dateRealimentation || "",
              nbFoyersCoupes: number(outage.nbFoyersCoupes),
              addresses: uniqueAddresses(addresses),
            });
          }

          for (const address of addresses) {
            addressRows += 1;
            const parsed = parseLocalisation(address.localisation, query.city);
            const key = [parsed.normalizedKey, parsed.postcode, stripAccents(parsed.city).toUpperCase()].join("|");
            let street = streetMap.get(key);
            if (!street) {
              street = {
                key,
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
              streetMap.set(key, street);
            }

            addUnique(street.localisations, address.localisation || "");
            addUnique(street.outageIds, outage.idCoupure || "");
            addUnique(street.outageTypes, outage.incidentCoupure || "Incident");
            street.nbFoyersCoupes += number(address.nbFoyersCoupes);
            street.firstSeenAt = earliestFrenchDate(street.firstSeenAt, outage.dateCoupure);
            street.estimatedRestoreAt = latestFrenchDate(street.estimatedRestoreAt, outage.dateRealimentation);
          }
        }
      }

      const streets = [...streetMap.values()].sort((left, right) => left.label.localeCompare(right.label));
      for (const street of streets) {
        street.outageIds.sort((left, right) => left.localeCompare(right));
        street.outageTypes.sort((left, right) => left.localeCompare(right));
      }

      if (options.geocode) {
        await this.geocodeStreets(streets);
        if (options.geometry) {
          await this.attachStreetGeometry(streets, options.geometryBounds);
        }
      }

      const outages = [...outageMap.values()].sort((left, right) => left.id.localeCompare(right.id));
      const stats = {
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
      };

      refreshStreetStats(stats, streets);

      span.setAttribute("outages.count", stats.outages);
      span.setAttribute("outages.streets", stats.streets);
      span.setAttribute("outages.geometries", stats.streetGeometry);

      const response = {
        updatedAt: new Date().toISOString(),
        source: sourceInfo(),
        query: queries[0] || {},
        polygon: combinePolygons(polygons),
        stats,
        outages,
        streets,
        recap,
        crises,
      };
      if (queries.length > 1) response.queries = queries;
      return response;
    });
  }

  async attachGeometryToResponse(response, geometryBounds) {
    if (!response?.streets?.length) return response;
    await this.attachStreetGeometry(response.streets, geometryBounds);
    refreshStreetStats(response.stats, response.streets);
    return response;
  }

  async geocodeStreets(streets) {
    if (!this.geocoder || streets.length === 0) return;
    await enterSpan(this.traceCtx, "outages.geocode_streets", { "outages.streets": streets.length }, async () => {
      await mapLimit(streets, MAX_GEOCODE_CONCURRENCY, async (street) => {
        const query = [street.normalizedName, street.city, street.postcode].join(" ").trim();
        const result = await this.geocoder.street(query);
        street.geocode = publicGeocode(result);
        if (!result.cached) await sleep(GEOCODE_MISS_DELAY_MS);
      });
      await this.geocoder.save?.();
    });
  }

  async attachStreetGeometry(streets, geometryBounds) {
    if (!this.geometries || streets.length === 0) return;
    await enterSpan(this.traceCtx, "outages.attach_geometry", { "outages.streets": streets.length }, async () => {
      const requests = streets.map((street) => {
        const request = {
          id: street.key,
          name: street.normalizedName,
        };
        if (street.geocode?.status === "ok") {
          request.point = { lat: street.geocode.lat, lng: street.geocode.lng };
        }
        return request;
      });

      const results = geometryBounds
        ? await this.geometries.streetRequestsInBounds(requests, geometryBounds)
        : await this.geometries.streetRequests(requests);

      for (const street of streets) {
        const result = results[street.key] || results[streetKey(street.normalizedName)];
        if (result) street.geometry = result;
      }
    });
  }
}

export function responseCommunes(items) {
  return items.map((item) => {
    const commune = {
      code: item.code,
      name: item.name,
      postcodes: item.postcodes || [],
    };
    if (item.center?.coordinates?.length >= 2) {
      commune.center = { lat: item.center.coordinates[1], lng: item.center.coordinates[0] };
    }
    if (item.contour) commune.contour = item.contour;
    return commune;
  });
}

export function mergeOutageResponses(responses) {
  const clean = responses.filter(Boolean);
  const streetMap = new Map();
  const outageMap = new Map();
  const polygons = [];
  const queries = [];
  let addressRows = 0;
  let compteurIncidentHTA = 0;
  let compteurTravauxHTA = 0;
  let compteurBT = 0;
  let recap = null;
  let crises = null;
  let updatedAt = "";

  for (const response of clean) {
    if (response.updatedAt && (!updatedAt || response.updatedAt > updatedAt)) updatedAt = response.updatedAt;
    if (response.polygon) polygons.push(response.polygon);
    if (response.query) queries.push(response.query);
    for (const query of response.queries || []) {
      if (!queries.some((existing) => existing.insee === query.insee && existing.city === query.city)) queries.push(query);
    }

    const stats = response.stats || {};
    addressRows += number(stats.addressRows);
    compteurIncidentHTA += number(stats.compteurIncidentHTA);
    compteurTravauxHTA += number(stats.compteurTravauxHTA);
    compteurBT += number(stats.compteurBT);
    if (!recap && response.recap) recap = response.recap;
    if (!crises && response.crises) crises = response.crises;

    for (const outage of response.outages || []) mergeOutage(outageMap, outage);
    for (const street of response.streets || []) mergeStreet(streetMap, street);
  }

  const streets = [...streetMap.values()].sort((left, right) => left.label.localeCompare(right.label));
  const outages = [...outageMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  const stats = {
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
  };
  refreshStreetStats(stats, streets);

  const merged = {
    updatedAt: updatedAt || new Date().toISOString(),
    source: sourceInfo(),
    query: queries[0] || {},
    polygon: combinePolygons(polygons),
    stats,
    outages,
    streets,
    recap,
    crises,
  };
  if (queries.length > 1) merged.queries = queries;
  return merged;
}

export function parseLocalisation(localisation, fallbackCity) {
  const parts = String(localisation || "").split(/,(.*)/s);
  const rawStreet = String(parts[0] || "").trim();
  let rawCity = fallbackCity || "";
  if (parts[1]) rawCity = String(parts[1]).trim();

  let postcode = "";
  const cityPostcode = rawCity.match(/\((\d{5})\)/);
  const streetPostcode = rawStreet.match(/\b(75\d{3})\b/);
  if (cityPostcode) postcode = cityPostcode[1];
  else if (streetPostcode) postcode = streetPostcode[1];

  let city = rawCity.replace(/\([^)]*\)/g, "").trim();
  if (!city) city = fallbackCity || "Paris";

  const normalizedName = normalizeStreet(rawStreet);
  return {
    label: titleCase(normalizedName),
    normalizedName,
    normalizedKey: stripAccents(normalizedName).toUpperCase(),
    city: titleCase(city),
    postcode,
  };
}

export function normalizeStreet(input) {
  let value = stripAccents(String(input || "")).toUpperCase();
  value = value.replaceAll("\u00a0", " ");
  value = value.replace(/[()]/g, " ");
  value = value.replace(/\s+/g, " ").trim();

  const replacements = [
    [/^\/+\s*/, ""],
    [/^ET\s+/, ""],
    [/^PARKING\s+VINCI\/ROSSINI\s+\d+\s+/, ""],
    [/^R[.\s]+/, "RUE "],
    [/^BD[.\s]+/, "BOULEVARD "],
    [/^BLD[.\s]+/, "BOULEVARD "],
    [/^AV(?:E)?[.\s]+/, "AVENUE "],
    [/^PL[.\s]+/, "PLACE "],
    [/^PAS[.\s]+/, "PASSAGE "],
    [/^IMP[.\s]+/, "IMPASSE "],
    [/^SQ[.\s]+/, "SQUARE "],
    [/\bFBG\b/g, "FAUBOURG"],
    [/\bFG\b/g, "FAUBOURG"],
    [/\bST\b/g, "SAINT"],
    [/\bSTE\b/g, "SAINTE"],
  ];
  for (const [pattern, replacement] of replacements) {
    value = value.replace(pattern, replacement);
    value = stripLeadingAddressNumber(value);
  }
  return value.replace(/\s+/g, " ").trim();
}

function stripLeadingAddressNumber(value) {
  const cleaned = String(value || "").trim().replace(/^\/+\s*/, "");
  const match = cleaned.match(/^\d+(?:[.\s]\d+)*[A-Z]?\s+(.+)$/);
  if (!match) return cleaned;
  const rest = match[1].trim();
  return looksLikeStreetName(rest) ? rest : cleaned;
}

function looksLikeStreetName(value) {
  return [
    "RUE ",
    "R. ",
    "R ",
    "BD ",
    "BLD ",
    "BOULEVARD ",
    "AV ",
    "AVE ",
    "AVENUE ",
    "PL ",
    "PLACE ",
    "PAS ",
    "PASSAGE ",
    "IMP ",
    "IMPASSE ",
    "SQ ",
    "SQUARE ",
    "VILLA ",
    "CITE ",
    "EGLISE ",
  ].some((prefix) => value.startsWith(prefix));
}

function titleCase(value) {
  const smallWords = new Set(["a", "au", "aux", "d", "de", "des", "du", "et", "l", "la", "le", "les"]);
  return String(value || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => (index > 0 && smallWords.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function earliestFrenchDate(current, candidate) {
  if (!candidate) return current || "";
  if (!current || parseFrenchDate(candidate) < parseFrenchDate(current)) return candidate;
  return current;
}

function latestFrenchDate(current, candidate) {
  if (!candidate) return current || "";
  if (!current || parseFrenchDate(candidate) > parseFrenchDate(current)) return candidate;
  return current;
}

function parseFrenchDate(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  if (!match) return new Date(0);
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]));
}

function combinePolygons(polygons) {
  const clean = polygons.filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];

  const features = [];
  for (const polygon of clean) {
    if (!polygon) continue;
    if (polygon.type === "FeatureCollection") {
      features.push(...(polygon.features || []));
    } else if (polygon.type === "Feature") {
      features.push(polygon);
    } else {
      features.push({
        type: "Feature",
        geometry: polygon,
        properties: {},
      });
    }
  }
  if (features.length === 0) return null;
  return { type: "FeatureCollection", features };
}

function uniqueAddresses(addresses) {
  const unique = [];
  for (const address of addresses || []) addUniqueAddress(unique, address);
  return unique;
}

function addUniqueAddress(addresses, address) {
  if (!address) return;
  if (addresses.some((existing) => existing.localisation === address.localisation && existing.nbFoyersCoupes === address.nbFoyersCoupes)) {
    return;
  }
  addresses.push({
    localisation: address.localisation || "",
    nbFoyersCoupes: number(address.nbFoyersCoupes),
  });
}

function refreshStreetStats(stats, streets) {
  if (!stats) return;
  stats.streets = streets.length;
  stats.geocodedStreets = 0;
  stats.geocodeMisses = 0;
  stats.streetGeometry = 0;
  stats.streetGeometryMisses = 0;
  for (const street of streets) {
    if (street.geocode) {
      if (street.geocode.status === "ok") stats.geocodedStreets += 1;
      else stats.geocodeMisses += 1;
    }
    if (street.geometry) {
      if (street.geometry.status === "ok" && street.geometry.lines?.length > 0) stats.streetGeometry += 1;
      else stats.streetGeometryMisses += 1;
    }
  }
}

function mergeStreet(streetMap, street) {
  const key = street.key || [street.normalizedName, street.postcode, stripAccents(street.city).toUpperCase()].join("|");
  const existing = streetMap.get(key);
  if (!existing) {
    streetMap.set(key, clone(street));
    return;
  }
  for (const value of street.localisations || []) addUnique(existing.localisations, value);
  for (const value of street.outageIds || []) addUnique(existing.outageIds, value);
  for (const value of street.outageTypes || []) addUnique(existing.outageTypes, value);
  existing.outageIds.sort((left, right) => left.localeCompare(right));
  existing.outageTypes.sort((left, right) => left.localeCompare(right));
  existing.nbFoyersCoupes += number(street.nbFoyersCoupes);
  existing.firstSeenAt = earliestFrenchDate(existing.firstSeenAt, street.firstSeenAt);
  existing.estimatedRestoreAt = latestFrenchDate(existing.estimatedRestoreAt, street.estimatedRestoreAt);
  if (!existing.geocode && street.geocode) existing.geocode = clone(street.geocode);
  if (!existing.geometry && street.geometry) existing.geometry = clone(street.geometry);
}

function mergeOutage(outageMap, outage) {
  const key = `${outage.codeInsee || ""}:${outage.id || ""}:${outage.dateCoupure || ""}`;
  const existing = outageMap.get(key);
  if (!existing) {
    outageMap.set(key, clone(outage));
    return;
  }
  existing.dateCoupure = earliestFrenchDate(existing.dateCoupure, outage.dateCoupure);
  existing.dateRealimentation = latestFrenchDate(existing.dateRealimentation, outage.dateRealimentation);
  existing.nbFoyersCoupes += number(outage.nbFoyersCoupes);
  for (const address of outage.addresses || []) addUniqueAddress(existing.addresses, address);
}

function sourceInfo() {
  return {
    enedisEndpoint: ENEDIS_ENDPOINT,
    geocoderEndpoint: GEOCODE_PRIMARY_ENDPOINT,
    geocoderFallbackEndpoint: GEOCODE_FALLBACK_ENDPOINT,
    streetGeometryEndpoint: STREET_GEOMETRY_PRIMARY_ENDPOINT,
  };
}

function normalizeOptions(shouldGeocode, geometryBounds) {
  if (typeof shouldGeocode === "object" && shouldGeocode !== null) {
    return {
      geocode: shouldGeocode.geocode !== false,
      geometry: shouldGeocode.geometry === true,
      geometryBounds: shouldGeocode.geometryBounds || geometryBounds || null,
    };
  }
  return {
    geocode: Boolean(shouldGeocode),
    geometry: Boolean(shouldGeocode),
    geometryBounds,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
