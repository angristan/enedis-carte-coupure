import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { UpstreamError } from "./errors.js";
import type { Bounds } from "./geo.js";
import { ENEDIS_ENDPOINT } from "./enedis.js";
import {
  GEOCODE_FALLBACK_ENDPOINT,
  GEOCODE_PRIMARY_ENDPOINT,
  Geocoder,
  publicGeocode,
} from "./geocode.js";
import type {
  Commune,
  EnedisAddress,
  EnedisQuery,
  NormalizeInput,
  Outage,
  OutageAddress,
  OutageResponse,
  OutageStats,
  PublicCommune,
  Street,
  StreetRequest,
} from "./models.js";
import {
  STREET_GEOMETRY_PRIMARY_ENDPOINT,
  StreetGeometryProvider,
  streetKey,
} from "./streetgeom.js";
import { addUnique, stripAccents } from "./util.js";

const MAX_GEOCODE_CONCURRENCY = 4;

const GeoJsonFeatureSchema = Schema.Struct({
  type: Schema.Literal("Feature"),
  geometry: Schema.Unknown,
  properties: Schema.optionalKey(Schema.Unknown),
});
const GeoJsonFeatureCollectionSchema = Schema.Struct({
  type: Schema.Literal("FeatureCollection"),
  features: Schema.Array(GeoJsonFeatureSchema),
});
const GeoJsonGeometrySchema = Schema.Struct({
  type: Schema.Union([
    Schema.Literal("Polygon"),
    Schema.Literal("MultiPolygon"),
  ]),
  coordinates: Schema.Unknown,
});
const decodePolygon = Schema.decodeUnknownOption(
  Schema.Union([
    GeoJsonFeatureCollectionSchema,
    GeoJsonFeatureSchema,
    GeoJsonGeometrySchema,
  ]),
);

type GeoJsonFeature = Schema.Schema.Type<typeof GeoJsonFeatureSchema>;
interface MutableOutage {
  id: string;
  status: string;
  type: string;
  etatElectrique: number;
  codeInsee: string;
  dateCoupure: string;
  dateRealimentation: string;
  nbFoyersCoupes: number;
  addresses: Array<OutageAddress>;
}
interface MutableStreet {
  key: string;
  label: string;
  normalizedName: string;
  city: string;
  postcode: string;
  localisations: Array<string>;
  outageIds: Array<string>;
  outageTypes: Array<string>;
  firstSeenAt: string;
  estimatedRestoreAt: string;
  nbFoyersCoupes: number;
  geocode?: Street["geocode"];
  geometry?: Street["geometry"];
}

export class Normalizer extends Context.Service<Normalizer, {
  readonly normalize: (
    raw: NormalizeInput["raw"],
    query: EnedisQuery,
    geocode: boolean,
  ) => Effect.Effect<OutageResponse, UpstreamError>;
  readonly normalizeSet: (
    inputs: ReadonlyArray<NormalizeInput>,
    options: {
      readonly geocode: boolean;
      readonly geometry: boolean;
      readonly geometryBounds?: Bounds;
    },
  ) => Effect.Effect<OutageResponse, UpstreamError>;
  readonly attachGeometry: (
    response: OutageResponse,
    bounds: Bounds,
  ) => Effect.Effect<OutageResponse, UpstreamError>;
}>()("Normalizer") {}

export const NormalizerLive = Layer.effect(Normalizer)(Effect.gen(function* () {
  const geocoder = yield* Geocoder;
  const geometries = yield* StreetGeometryProvider;
  const attachStreetGeometry = Effect.fn("Normalizer.attachStreetGeometry")(
    function* (streets: ReadonlyArray<Street>, bounds?: Bounds) {
      if (streets.length === 0) return streets;
      const requests: Array<StreetRequest> = streets.map((street) =>
        street.geocode?.status === "ok"
          ? {
            id: street.key,
            name: street.normalizedName,
            point: { lat: street.geocode.lat, lng: street.geocode.lng },
          }
          : { id: street.key, name: street.normalizedName }
      );
      const results = yield* (bounds === undefined
        ? geometries.streetRequests(requests)
        : geometries.streetRequestsInBounds(requests, bounds));
      return streets.map((street) => {
        const geometry = results[street.key] ??
          results[streetKey(street.normalizedName)];
        return geometry === undefined ? street : { ...street, geometry };
      });
    },
  );
  const normalizeSet = Effect.fn("Normalizer.normalizeSet")(
    function* (
      inputs: ReadonlyArray<NormalizeInput>,
      options: {
        readonly geocode: boolean;
        readonly geometry: boolean;
        readonly geometryBounds?: Bounds;
      },
    ) {
      const now = yield* Clock.currentTimeMillis;
      let response = normalizePure(inputs, new Date(now).toISOString());
      if (options.geocode && response.streets.length > 0) {
        const streets = yield* Effect.forEach(response.streets, (street) =>
          Effect.gen(function* () {
            const result = yield* geocoder.street(
              [street.normalizedName, street.city, street.postcode].join(" ")
                .trim(),
            );
            if (!result.cached) {
              yield* Effect.sleep("120 millis");
            }
            return { ...street, geocode: publicGeocode(result) };
          }), { concurrency: MAX_GEOCODE_CONCURRENCY });
        response = {
          ...response,
          streets,
          stats: refreshStreetStats(response.stats, streets),
        };
        if (options.geometry) {
          const withGeometry = yield* attachStreetGeometry(
            streets,
            options.geometryBounds,
          );
          response = {
            ...response,
            streets: withGeometry,
            stats: refreshStreetStats(response.stats, withGeometry),
          };
        }
      }
      return response;
    },
  );
  const attachGeometry = Effect.fn("Normalizer.attachGeometry")(
    function* (response: OutageResponse, bounds: Bounds) {
      const streets = yield* attachStreetGeometry(response.streets, bounds);
      return {
        ...response,
        streets,
        stats: refreshStreetStats(response.stats, streets),
      };
    },
  );
  return {
    normalize: (raw, query, geocode) =>
      normalizeSet([{ raw, query }], { geocode, geometry: geocode }),
    normalizeSet,
    attachGeometry,
  };
}));

function normalizePure(
  inputs: ReadonlyArray<NormalizeInput>,
  updatedAt: string,
): OutageResponse {
  const streetMap = new Map<string, MutableStreet>();
  const outageMap = new Map<string, MutableOutage>();
  const queries: Array<EnedisQuery> = [];
  let addressRows = 0,
    compteurIncidentHTA = 0,
    compteurTravauxHTA = 0,
    compteurBT = 0;
  const polygons: Array<unknown> = [];
  let recap: unknown;
  let crises: unknown;
  for (const input of inputs) {
    const { raw, query } = input;
    queries.push(query);
    if (raw.polygon !== undefined) polygons.push(raw.polygon);
    const data = raw.resultMegacache;
    if (data === undefined) continue;
    compteurIncidentHTA += number(data.compteurIncidentHTA);
    compteurTravauxHTA += number(data.compteurTravauxHTA);
    compteurBT += number(data.compteurBT);
    recap ??= data.recap;
    crises ??= data.listeCrises;
    for (
      const [index, outage] of (data.listeCoupuresInfoReseau ?? []).entries()
    ) {
      const key = outage.idCoupure ?? `${query.insee}:${index}`;
      const addresses = outage.listeAdresses ?? [];
      const existing = outageMap.get(key);
      if (existing === undefined) {
        outageMap.set(key, {
          id: outage.idCoupure ?? "",
          status: outage.etatCoupure ?? "",
          type: outage.incidentCoupure ?? "",
          etatElectrique: number(outage.etatElectrique),
          codeInsee: outage.codeInsee ?? "",
          dateCoupure: outage.dateCoupure ?? "",
          dateRealimentation: outage.dateRealimentation ?? "",
          nbFoyersCoupes: number(outage.nbFoyersCoupes),
          addresses: uniqueAddresses(addresses),
        });
      } else {
        existing.dateCoupure = earliestFrenchDate(
          existing.dateCoupure,
          outage.dateCoupure ?? "",
        );
        existing.dateRealimentation = latestFrenchDate(
          existing.dateRealimentation,
          outage.dateRealimentation ?? "",
        );
        existing.nbFoyersCoupes += number(outage.nbFoyersCoupes);
        for (const address of addresses) {
          addUniqueAddress(existing.addresses, address);
        }
      }
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
        street.nbFoyersCoupes += number(address.nbFoyersCoupes);
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
  })).sort((a, b) => a.label.localeCompare(b.label));
  const outages: Array<Outage> = [...outageMap.values()].sort((a, b) =>
    a.id.localeCompare(b.id)
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
  const query = queries[0] ??
    {
      insee: "",
      type: "",
      adresse: "",
      CPVille: "",
      name: "",
      district: "",
      city: "",
    };
  const polygon = combinePolygons(polygons);
  return {
    updatedAt,
    source: sourceInfo(),
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
export function mergeOutageResponses(
  responses: ReadonlyArray<OutageResponse>,
): OutageResponse {
  if (responses.length === 0) {
    return normalizePure([], new Date(0).toISOString());
  }
  const streetMap = new Map<string, MutableStreet>();
  const outageMap = new Map<string, MutableOutage>();
  const queries: Array<EnedisQuery> = [];
  const warnings: Array<string> = [];
  const polygons: Array<unknown> = [];
  let recap: unknown;
  let crises: unknown;
  let addressRows = 0,
    compteurIncidentHTA = 0,
    compteurTravauxHTA = 0,
    compteurBT = 0,
    updatedAt = "";
  for (const response of responses) {
    if (response.updatedAt > updatedAt) updatedAt = response.updatedAt;
    for (const query of response.queries ?? [response.query]) {
      if (
        !queries.some((item) =>
          item.insee === query.insee && item.city === query.city
        )
      ) queries.push(query);
    }
    addressRows += response.stats.addressRows;
    compteurIncidentHTA += response.stats.compteurIncidentHTA;
    compteurTravauxHTA += response.stats.compteurTravauxHTA;
    compteurBT += response.stats.compteurBT;
    if (response.polygon !== undefined) polygons.push(response.polygon);
    recap ??= response.recap;
    crises ??= response.crises;
    warnings.push(...(response.warnings ?? []));
    for (const street of response.streets) mergeStreet(streetMap, street);
    for (const outage of response.outages) mergeOutage(outageMap, outage);
  }
  const streets: Array<Street> = [...streetMap.values()].sort((a, b) =>
    a.label.localeCompare(b.label)
  );
  const outages: Array<Outage> = [...outageMap.values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const query = queries[0] ?? responses[0].query;
  const polygon = combinePolygons(polygons);
  return {
    updatedAt,
    source: sourceInfo(),
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

function combinePolygons(
  polygons: ReadonlyArray<unknown>,
): unknown | undefined {
  const decoded = polygons.flatMap((polygon) => {
    const result = decodePolygon(polygon);
    return Option.isSome(result) ? [result.value] : [];
  });
  if (decoded.length === 0) return undefined;
  if (decoded.length === 1) return decoded[0];

  const features: Array<GeoJsonFeature> = [];
  for (const polygon of decoded) {
    if (polygon.type === "FeatureCollection") {
      features.push(...polygon.features);
    } else if (polygon.type === "Feature") {
      features.push(polygon);
    } else {
      features.push({ type: "Feature", geometry: polygon, properties: {} });
    }
  }
  return { type: "FeatureCollection", features };
}

function mergeStreet(map: Map<string, MutableStreet>, street: Street): void {
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
  for (const value of street.localisations) {
    addUnique(current.localisations, value);
  }
  for (const value of street.outageIds) addUnique(current.outageIds, value);
  for (const value of street.outageTypes) addUnique(current.outageTypes, value);
  current.nbFoyersCoupes += street.nbFoyersCoupes;
  current.firstSeenAt = earliestFrenchDate(
    current.firstSeenAt,
    street.firstSeenAt,
  );
  current.estimatedRestoreAt = latestFrenchDate(
    current.estimatedRestoreAt,
    street.estimatedRestoreAt,
  );
  current.geocode ??= street.geocode;
  current.geometry ??= street.geometry;
}
function mergeOutage(map: Map<string, MutableOutage>, outage: Outage): void {
  const key = `${outage.codeInsee}:${outage.id}:${outage.dateCoupure}`;
  const current = map.get(key);
  if (current === undefined) {
    map.set(key, { ...outage, addresses: [...outage.addresses] });
    return;
  }
  current.nbFoyersCoupes += outage.nbFoyersCoupes;
  current.dateCoupure = earliestFrenchDate(
    current.dateCoupure,
    outage.dateCoupure,
  );
  current.dateRealimentation = latestFrenchDate(
    current.dateRealimentation,
    outage.dateRealimentation,
  );
  for (const address of outage.addresses) {
    addUniqueAddress(current.addresses, address);
  }
}
export function parseLocalisation(
  localisation: string,
  fallbackCity: string,
): {
  label: string;
  normalizedName: string;
  normalizedKey: string;
  city: string;
  postcode: string;
} {
  const parts = localisation.split(/,(.*)/s);
  const rawStreet = (parts[0] ?? "").trim();
  const rawCity = (parts[1] ?? fallbackCity).trim();
  const postcode = rawCity.match(/\((\d{5})\)/)?.[1] ??
    rawStreet.match(/\b(75\d{3})\b/)?.[1] ?? "";
  const city = rawCity.replace(/\([^)]*\)/g, "").trim() || fallbackCity ||
    "Paris";
  const normalizedName = normalizeStreet(rawStreet);
  return {
    label: titleCase(normalizedName),
    normalizedName,
    normalizedKey: stripAccents(normalizedName).toUpperCase(),
    city: titleCase(city),
    postcode,
  };
}
export function normalizeStreet(input: string): string {
  let value = stripAccents(input).toUpperCase().replaceAll("\u00a0", " ")
    .replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
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
    value = stripLeadingAddressNumber(value.replace(pattern, replacement));
  }
  return value.replace(/\s+/g, " ").trim();
}
function stripLeadingAddressNumber(value: string): string {
  const clean = value.trim().replace(/^\/+\s*/, "");
  const rest = clean.match(/^\d+(?:[.\s]\d+)*[A-Z]?\s+(.+)$/)?.[1]?.trim();
  return rest !== undefined &&
      [
        "RUE ",
        "R. ",
        "R ",
        "BD ",
        "BOULEVARD ",
        "AV ",
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
      ].some((prefix) => rest.startsWith(prefix))
    ? rest
    : clean;
}
function titleCase(value: string): string {
  const small = new Set([
    "a",
    "au",
    "aux",
    "d",
    "de",
    "des",
    "du",
    "et",
    "l",
    "la",
    "le",
    "les",
  ]);
  return value.toLowerCase().split(/\s+/).filter(Boolean).map((word, index) =>
    index > 0 && small.has(word)
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1)
  ).join(" ");
}
function parseFrenchDate(value: string): number {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  return match === null ? 0 : new Date(
    Number(match[3]),
    Number(match[2]) - 1,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
}
const earliestFrenchDate = (current: string, candidate: string): string =>
  candidate.length > 0 &&
    (current.length === 0 ||
      parseFrenchDate(candidate) < parseFrenchDate(current))
    ? candidate
    : current;
const latestFrenchDate = (current: string, candidate: string): string =>
  candidate.length > 0 &&
    (current.length === 0 ||
      parseFrenchDate(candidate) > parseFrenchDate(current))
    ? candidate
    : current;
function uniqueAddresses(
  addresses: ReadonlyArray<EnedisAddress>,
): Array<OutageAddress> {
  const output: Array<OutageAddress> = [];
  for (const address of addresses) addUniqueAddress(output, address);
  return output;
}
function addUniqueAddress(
  addresses: Array<OutageAddress>,
  address: EnedisAddress | OutageAddress,
): void {
  const item = {
    localisation: address.localisation ?? "",
    nbFoyersCoupes: number(address.nbFoyersCoupes),
  };
  if (
    !addresses.some((existing) =>
      existing.localisation === item.localisation &&
      existing.nbFoyersCoupes === item.nbFoyersCoupes
    )
  ) addresses.push(item);
}
function refreshStreetStats(
  stats: OutageStats,
  streets: ReadonlyArray<Street>,
): OutageStats {
  let geocodedStreets = 0,
    geocodeMisses = 0,
    streetGeometry = 0,
    streetGeometryMisses = 0;
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
const sourceInfo = () => ({
  enedisEndpoint: ENEDIS_ENDPOINT,
  geocoderEndpoint: GEOCODE_PRIMARY_ENDPOINT,
  geocoderFallbackEndpoint: GEOCODE_FALLBACK_ENDPOINT,
  streetGeometryEndpoint: STREET_GEOMETRY_PRIMARY_ENDPOINT,
});
function number(value: string | number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
