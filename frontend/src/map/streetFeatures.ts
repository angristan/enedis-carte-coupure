import type { FeatureCollection, MultiLineString, Point } from "geojson";
import type { Street } from "../../../shared/api.js";
import { copyLine, hasGeometry, mergedGeometryLines } from "./streetLines.js";

interface StreetFeatureProperties {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly lineWidth: number;
  readonly radius: number;
  readonly selected: boolean;
}

export type StreetFeatureCollection = FeatureCollection<
  MultiLineString | Point,
  StreetFeatureProperties
>;

export function streetFeatureCollection(
  streets: ReadonlyArray<Street>,
  activeKey: string,
): StreetFeatureCollection {
  const features: StreetFeatureCollection["features"] = [];

  for (const street of streets) {
    const properties = streetFeatureProperties(street, activeKey);
    const lines = mergedGeometryLines(street);

    if (lines.length > 0) {
      features.push({
        type: "Feature",
        id: street.key,
        properties,
        geometry: {
          type: "MultiLineString",
          coordinates: lines.map(copyLine),
        },
      });
    } else if (street.geocode?.status === "ok") {
      features.push({
        type: "Feature",
        id: street.key,
        properties,
        geometry: {
          type: "Point",
          coordinates: [street.geocode.lng, street.geocode.lat],
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}

export function hasMapLayer(street: Street): boolean {
  return hasGeometry(street) || street.geocode?.status === "ok";
}

function streetFeatureProperties(
  street: Street,
  activeKey: string,
): StreetFeatureProperties {
  return {
    key: street.key,
    label: street.label,
    color: markerColor(street),
    lineWidth: lineWeight(street),
    radius: markerRadius(street),
    selected: street.key === activeKey,
  };
}

function markerColor(street: Street): string {
  if (street.outageTypes.includes("Incident HTA")) return "#e45245";
  if (street.outageTypes.includes("Incident BT")) return "#e98a19";

  return "#087d70";
}

function markerRadius(street: Street): number {
  const count = street.outageIds.length || 1;

  return Math.min(13, 7 + count * 1.5);
}

function lineWeight(street: Street): number {
  const count = street.outageIds.length || 1;

  return Math.min(6.6, 4.2 + Math.min(1.2, (count - 1) * 0.35));
}
