import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { Option, Schema } from "effect";

export type AreaFeatureCollection = FeatureCollection<Polygon | MultiPolygon>;

const PositionSchema = Schema.Array(Schema.Number);

const PolygonSchema = Schema.Struct({
  type: Schema.Literal("Polygon"),
  coordinates: Schema.Array(Schema.Array(PositionSchema)),
});

const MultiPolygonSchema = Schema.Struct({
  type: Schema.Literal("MultiPolygon"),
  coordinates: Schema.Array(Schema.Array(Schema.Array(PositionSchema))),
});

const AreaFeatureSchema = Schema.Struct({
  type: Schema.Literal("Feature"),
  geometry: Schema.Union([PolygonSchema, MultiPolygonSchema]),
  properties: Schema.optionalKey(Schema.Unknown),
});

const AreaFeatureCollectionSchema = Schema.Struct({
  type: Schema.Literal("FeatureCollection"),
  features: Schema.Array(AreaFeatureSchema),
});

const decodeArea = Schema.decodeUnknownOption(AreaFeatureCollectionSchema);

export function decodeAreaFeatureCollection(
  input: unknown,
): AreaFeatureCollection | undefined {
  const decoded = decodeArea(input);

  if (Option.isNone(decoded)) return undefined;

  return {
    type: "FeatureCollection",
    features: decoded.value.features.map((feature) => ({
      type: "Feature",
      properties: objectOrEmpty(feature.properties),
      geometry: feature.geometry.type === "Polygon"
        ? {
          type: "Polygon",
          coordinates: feature.geometry.coordinates.map(copyRing),
        }
        : {
          type: "MultiPolygon",
          coordinates: feature.geometry.coordinates.map((polygon) =>
            polygon.map(copyRing)
          ),
        },
    })),
  };
}

function copyRing(
  ring: ReadonlyArray<ReadonlyArray<number>>,
): Array<Array<number>> {
  return ring.map((position) => [...position]);
}

function objectOrEmpty(value: unknown): object {
  return typeof value === "object" && value !== null ? value : {};
}
