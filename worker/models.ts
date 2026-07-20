import { Schema } from "effect";
import { OutageResponseSchema } from "../shared/api.js";
import type {
  Bounds,
  EnedisQuery,
  OutageResponse,
  Position,
  PublicGeocode,
  StreetGeometry,
} from "../shared/api.js";

export {
  ApiErrorResponseSchema,
  BoundsSchema,
  EnedisQuerySchema,
  OutageStatsSchema,
  PositionSchema,
  PublicCommuneSchema,
  PublicGeocodeSchema,
  StreetGeometrySchema,
  StreetSchema,
} from "../shared/api.js";

export type {
  ApiErrorResponse,
  Bounds,
  EnedisQuery,
  Outage,
  OutageAddress,
  OutageResponse,
  OutageSource,
  OutageStats,
  Position,
  PublicCommune,
  PublicGeocode,
  Street,
  StreetGeometry,
} from "../shared/api.js";

export const CoordinatesSchema = Schema.Tuple([Schema.Number, Schema.Number]);

export type Coordinates = Schema.Schema.Type<typeof CoordinatesSchema>;

export const GeoJsonGeometrySchema = Schema.Struct({
  type: Schema.String,
  coordinates: Schema.Unknown,
});

export type GeoJsonGeometry = Schema.Schema.Type<typeof GeoJsonGeometrySchema>;

export const CommuneSchema = Schema.Struct({
  name: Schema.String,
  code: Schema.String,
  postcodes: Schema.Array(Schema.String),
  center: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      coordinates: CoordinatesSchema,
    }),
  ),
  contour: Schema.optionalKey(Schema.NullOr(GeoJsonGeometrySchema)),
});

export type Commune = Schema.Schema.Type<typeof CommuneSchema>;

export const EnedisAddressSchema = Schema.Struct({
  localisation: Schema.optionalKey(Schema.String),
  nbFoyersCoupes: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number]),
  ),
});

export type EnedisAddress = Schema.Schema.Type<typeof EnedisAddressSchema>;

export const EnedisOutageSchema = Schema.Struct({
  idCoupure: Schema.optionalKey(Schema.String),
  etatCoupure: Schema.optionalKey(Schema.String),
  incidentCoupure: Schema.optionalKey(Schema.String),
  etatElectrique: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number]),
  ),
  codeInsee: Schema.optionalKey(Schema.String),
  dateCoupure: Schema.optionalKey(Schema.String),
  dateRealimentation: Schema.optionalKey(Schema.String),
  nbFoyersCoupes: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number]),
  ),
  listeAdresses: Schema.optionalKey(Schema.Array(EnedisAddressSchema)),
});

export type EnedisOutage = Schema.Schema.Type<typeof EnedisOutageSchema>;

export const EnedisPayloadSchema = Schema.Struct({
  polygon: Schema.optionalKey(Schema.Unknown),
  resultMegacache: Schema.optionalKey(Schema.Struct({
    compteurIncidentHTA: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Number]),
    ),
    compteurTravauxHTA: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Number]),
    ),
    compteurBT: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Number]),
    ),
    recap: Schema.optionalKey(Schema.Unknown),
    listeCrises: Schema.optionalKey(Schema.Unknown),
    listeCoupuresInfoReseau: Schema.optionalKey(
      Schema.Array(EnedisOutageSchema),
    ),
  })),
});

export type EnedisPayload = Schema.Schema.Type<typeof EnedisPayloadSchema>;

export type GeocodeResult = PublicGeocode & { readonly cached: boolean };

export const GeocodePayloadSchema = Schema.Struct({
  features: Schema.optionalKey(Schema.Array(Schema.Struct({
    geometry: Schema.Struct({ coordinates: CoordinatesSchema }),
    properties: Schema.optionalKey(Schema.Struct({
      label: Schema.optionalKey(Schema.String),
      score: Schema.optionalKey(Schema.Number),
      type: Schema.optionalKey(Schema.String),
      postcode: Schema.optionalKey(Schema.String),
      citycode: Schema.optionalKey(Schema.String),
    })),
  }))),
});

export const OverpassPayloadSchema = Schema.Struct({
  elements: Schema.optionalKey(Schema.Array(Schema.Struct({
    type: Schema.String,
    geometry: Schema.optionalKey(
      Schema.Array(Schema.Struct({ lat: Schema.Number, lon: Schema.Number })),
    ),
    tags: Schema.optionalKey(
      Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
    ),
  }))),
});

export interface StreetRequest {
  readonly id: string;
  readonly name: string;
  readonly point?: Position;
}

export type StreetGeometryResults = Readonly<Record<string, StreetGeometry>>;

export interface NormalizeInput {
  readonly raw: EnedisPayload;
  readonly query: EnedisQuery;
}

export const CommuneOutageCacheSchema = Schema.Struct({
  version: Schema.Literal(3),
  refreshedAt: Schema.String,
  freshUntil: Schema.String,
  response: OutageResponseSchema,
});

export type CommuneOutageCacheEntry = Schema.Schema.Type<
  typeof CommuneOutageCacheSchema
>;

export { OutageResponseSchema };
