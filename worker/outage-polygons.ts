import { Option, Schema } from "effect";

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

const SupportedGeoJsonSchema = Schema.Union([
  GeoJsonFeatureCollectionSchema,
  GeoJsonFeatureSchema,
  GeoJsonGeometrySchema,
]);

const decodePolygon = Schema.decodeUnknownOption(SupportedGeoJsonSchema);

type GeoJsonFeature = Schema.Schema.Type<typeof GeoJsonFeatureSchema>;

export function combinePolygons(
  polygons: ReadonlyArray<unknown>,
): unknown | undefined {
  const decoded = polygons.flatMap((polygon) => {
    const result = decodePolygon(polygon);

    return Option.isSome(result) ? [result.value] : [];
  });

  if (decoded.length === 0) {
    return undefined;
  }
  if (decoded.length === 1) {
    return decoded[0];
  }

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
