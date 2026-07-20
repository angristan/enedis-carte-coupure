import { Schema } from "effect";

export interface Bounds {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export const BoundsSchema = Schema.Struct({
  south: Schema.Number,
  west: Schema.Number,
  north: Schema.Number,
  east: Schema.Number,
});

export interface Position {
  readonly lat: number;
  readonly lng: number;
}

export const PositionSchema = Schema.Struct({
  lat: Schema.Number,
  lng: Schema.Number,
});

export interface PublicCommune {
  readonly code: string;
  readonly name: string;
  readonly postcodes: ReadonlyArray<string>;
  readonly center?: Position;
  readonly contour?: unknown;
}

export const PublicCommuneSchema = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  postcodes: Schema.Array(Schema.String),
  center: Schema.optionalKey(PositionSchema),
  contour: Schema.optionalKey(Schema.Unknown),
});

export interface EnedisQuery {
  readonly insee: string;
  readonly type: string;
  readonly adresse: string;
  readonly CPVille: string;
  readonly name: string;
  readonly district: string;
  readonly city: string;
  readonly longitude?: string;
  readonly latitude?: string;
  readonly department?: string;
}

export const EnedisQuerySchema = Schema.Struct({
  insee: Schema.String,
  type: Schema.String,
  adresse: Schema.String,
  CPVille: Schema.String,
  name: Schema.String,
  district: Schema.String,
  city: Schema.String,
  longitude: Schema.optionalKey(Schema.String),
  latitude: Schema.optionalKey(Schema.String),
  department: Schema.optionalKey(Schema.String),
});

export interface OutageAddress {
  readonly localisation: string;
  readonly nbFoyersCoupes: number;
}

export const OutageAddressSchema = Schema.Struct({
  localisation: Schema.String,
  nbFoyersCoupes: Schema.Number,
});

export interface Outage {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly etatElectrique: number;
  readonly codeInsee: string;
  readonly dateCoupure: string;
  readonly dateRealimentation: string;
  readonly nbFoyersCoupes: number;
  readonly addresses: ReadonlyArray<OutageAddress>;
}

export const OutageSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  type: Schema.String,
  etatElectrique: Schema.Number,
  codeInsee: Schema.String,
  dateCoupure: Schema.String,
  dateRealimentation: Schema.String,
  nbFoyersCoupes: Schema.Number,
  addresses: Schema.Array(OutageAddressSchema),
});

export interface GeocodeOk {
  readonly status: "ok";
  readonly query: string;
  readonly lng: number;
  readonly lat: number;
  readonly label: string;
  readonly score?: number;
  readonly type: string;
  readonly postcode: string;
  readonly citycode: string;
}

export interface GeocodeMiss {
  readonly status: "miss";
  readonly query: string;
}

export interface GeocodeError {
  readonly status: "error";
  readonly query: string;
  readonly message: string;
}

export type PublicGeocode = GeocodeOk | GeocodeMiss | GeocodeError;

export const PublicGeocodeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    query: Schema.String,
    lng: Schema.Number,
    lat: Schema.Number,
    label: Schema.String,
    score: Schema.optionalKey(Schema.Number),
    type: Schema.String,
    postcode: Schema.String,
    citycode: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("miss"), query: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("error"),
    query: Schema.String,
    message: Schema.String,
  }),
]);

export interface StreetGeometryOk {
  readonly status: "ok";
  readonly source: string;
  readonly osmNames: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<ReadonlyArray<Position>>;
  readonly query?: string;
  readonly updatedAt?: string;
}

export interface StreetGeometryMiss {
  readonly status: "miss";
  readonly query: string;
  readonly updatedAt: string;
  readonly message?: string;
}

export type StreetGeometry = StreetGeometryOk | StreetGeometryMiss;

export const StreetGeometrySchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    source: Schema.String,
    osmNames: Schema.Array(Schema.String),
    lines: Schema.Array(Schema.Array(PositionSchema)),
    query: Schema.optionalKey(Schema.String),
    updatedAt: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("miss"),
    query: Schema.String,
    updatedAt: Schema.String,
    message: Schema.optionalKey(Schema.String),
  }),
]);

export interface Street {
  readonly key: string;
  readonly label: string;
  readonly normalizedName: string;
  readonly city: string;
  readonly postcode: string;
  readonly localisations: ReadonlyArray<string>;
  readonly outageIds: ReadonlyArray<string>;
  readonly outageTypes: ReadonlyArray<string>;
  readonly firstSeenAt: string;
  readonly estimatedRestoreAt: string;
  readonly nbFoyersCoupes: number;
  readonly geocode?: PublicGeocode | null;
  readonly geometry?: StreetGeometry;
}

export const StreetSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  normalizedName: Schema.String,
  city: Schema.String,
  postcode: Schema.String,
  localisations: Schema.Array(Schema.String),
  outageIds: Schema.Array(Schema.String),
  outageTypes: Schema.Array(Schema.String),
  firstSeenAt: Schema.String,
  estimatedRestoreAt: Schema.String,
  nbFoyersCoupes: Schema.Number,
  geocode: Schema.optionalKey(Schema.NullOr(PublicGeocodeSchema)),
  geometry: Schema.optionalKey(StreetGeometrySchema),
});

export interface OutageStats {
  readonly outages: number;
  readonly addressRows: number;
  readonly streets: number;
  readonly geocodedStreets: number;
  readonly geocodeMisses: number;
  readonly streetGeometry: number;
  readonly streetGeometryMisses: number;
  readonly compteurIncidentHTA: number;
  readonly compteurTravauxHTA: number;
  readonly compteurBT: number;
}

export const OutageStatsSchema = Schema.Struct({
  outages: Schema.Number,
  addressRows: Schema.Number,
  streets: Schema.Number,
  geocodedStreets: Schema.Number,
  geocodeMisses: Schema.Number,
  streetGeometry: Schema.Number,
  streetGeometryMisses: Schema.Number,
  compteurIncidentHTA: Schema.Number,
  compteurTravauxHTA: Schema.Number,
  compteurBT: Schema.Number,
});

export interface OutageSource {
  readonly enedisEndpoint: string;
  readonly geocoderEndpoint: string;
  readonly geocoderFallbackEndpoint: string;
  readonly streetGeometryEndpoint: string;
}

export const OutageSourceSchema = Schema.Struct({
  enedisEndpoint: Schema.String,
  geocoderEndpoint: Schema.String,
  geocoderFallbackEndpoint: Schema.String,
  streetGeometryEndpoint: Schema.String,
});

export interface OutageResponse {
  readonly updatedAt: string;
  readonly source: OutageSource;
  readonly query: EnedisQuery;
  readonly queries?: ReadonlyArray<EnedisQuery>;
  readonly polygon?: unknown;
  readonly stats: OutageStats;
  readonly outages: ReadonlyArray<Outage>;
  readonly streets: ReadonlyArray<Street>;
  readonly recap?: unknown;
  readonly crises?: unknown;
  readonly viewport?: Bounds;
  readonly communes?: ReadonlyArray<PublicCommune>;
  readonly communeTotal?: number;
  readonly commune?: PublicCommune;
  readonly warnings?: ReadonlyArray<string>;
  readonly raw?: unknown;
}

export const OutageResponseSchema = Schema.Struct({
  updatedAt: Schema.String,
  source: OutageSourceSchema,
  query: EnedisQuerySchema,
  queries: Schema.optionalKey(Schema.Array(EnedisQuerySchema)),
  polygon: Schema.optionalKey(Schema.Unknown),
  stats: OutageStatsSchema,
  outages: Schema.Array(OutageSchema),
  streets: Schema.Array(StreetSchema),
  recap: Schema.optionalKey(Schema.Unknown),
  crises: Schema.optionalKey(Schema.Unknown),
  viewport: Schema.optionalKey(BoundsSchema),
  communes: Schema.optionalKey(Schema.Array(PublicCommuneSchema)),
  communeTotal: Schema.optionalKey(Schema.Number),
  commune: Schema.optionalKey(PublicCommuneSchema),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  raw: Schema.optionalKey(Schema.Unknown),
});

export interface ApiErrorResponse {
  readonly error: string;
  readonly message: string;
  readonly warnings?: ReadonlyArray<string>;
}

export const ApiErrorResponseSchema = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
});
